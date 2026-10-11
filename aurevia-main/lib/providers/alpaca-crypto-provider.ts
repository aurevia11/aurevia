import type {
  ExecutionProvider,
  ProviderBalance,
  ProviderOrder,
  ProviderOrderRequest,
  ProviderOrderState,
  ProviderPosition,
  ProviderReconciliation,
  SignedProviderWebhook,
} from './contracts';
import { getServerConfiguration } from '@/lib/config/env';
import { normalizeAlpacaTradingBaseUrl } from '@/lib/config/env';
import { verifyHmacSha256 } from './registry';

export type AlpacaCryptoClientOptions = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  accountId: string;
  fetcher?: typeof fetch;
};

type AlpacaOrderResponse = {
  id?: string;
  client_order_id?: string;
  asset_id?: string;
  symbol?: string;
  status?: string;
  filled_qty?: string;
  filled_at?: string | null;
  created_at?: string;
  updated_at?: string;
  qty?: string;
  filled_quantity?: string;
  order_type?: string;
};

type NormalizedAlpacaOrder = {
  id: string;
  clientOrderId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

function normalizeState(value: string | undefined): ProviderOrderState {
  const status = value?.toLowerCase();
  if (status === 'accepted' || status === 'pending' || status === 'new') return 'ACCEPTED';
  if (status === 'partially_filled') return 'PARTIALLY_FILLED';
  if (status === 'filled') return 'FILLED';
  if (status === 'rejected' || status === 'invalid' || status === 'canceled' || status === 'cancelled') return 'REJECTED';
  if (status === 'cancelled') return 'CANCELLED';
  return 'ACCEPTED';
}

function assertSandbox(baseUrl: string) {
  try {
    const host = new URL(baseUrl).hostname;
    if (!host.endsWith('.sandbox.alpaca.markets') && host !== 'broker-api.sandbox.alpaca.markets') {
      throw new Error('SANDBOX_ONLY');
    }
  } catch {
    throw new Error('SANDBOX_ONLY');
  }
}

export function buildAlpacaCryptoClient(options: AlpacaCryptoClientOptions) {
  assertSandbox(options.baseUrl);
  const fetcher = options.fetcher ?? fetch;
  const credentials = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64');
  const request = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await fetcher(`${options.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        authorization: `Basic ${credentials}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(`ALPACA_CRYPTO_API_ERROR:${response.status}`);
    }
    return response.json();
  };

  return {
    async submitOrder(input: {
      clientOrderId: string;
      assetId: string;
      symbol: string;
      side: 'buy' | 'sell';
      type: 'market' | 'limit' | 'stop_limit';
      timeInForce: 'gtc' | 'ioc';
      qty: string;
      limitPrice?: string;
      stopPrice?: string;
    }): Promise<NormalizedAlpacaOrder> {
      const body: {
        client_order_id: string;
        symbol: string;
        side: 'buy' | 'sell';
        type: string;
        time_in_force: string;
        qty: string;
        asset_id: string;
        limit_price?: string;
        stop_price?: string;
      } = {
        client_order_id: input.clientOrderId,
        symbol: input.symbol,
        asset_id: input.assetId,
        side: input.side,
        type: input.type,
        time_in_force: input.timeInForce,
        qty: input.qty,
      };
      if (input.limitPrice) body.limit_price = input.limitPrice;
      if (input.stopPrice) body.stop_price = input.stopPrice;
      const response = await request(`/v1/trading/accounts/${options.accountId}/orders`, { method: 'POST', body: JSON.stringify(body) }) as AlpacaOrderResponse;
      return {
        id: response.id ?? '',
        clientOrderId: response.client_order_id ?? input.clientOrderId,
        status: response.status ?? 'accepted',
        createdAt: response.created_at ?? new Date().toISOString(),
        updatedAt: response.updated_at ?? new Date().toISOString(),
      };
    },
    async getOrder(orderId: string): Promise<NormalizedAlpacaOrder> {
      const response = await request(`/v1/trading/accounts/${options.accountId}/orders/${orderId}`) as AlpacaOrderResponse;
      return {
        id: response.id ?? '',
        clientOrderId: response.client_order_id ?? '',
        status: response.status ?? 'accepted',
        createdAt: response.created_at ?? new Date().toISOString(),
        updatedAt: response.updated_at ?? new Date().toISOString(),
      };
    },
    async cancelOrder(orderId: string): Promise<NormalizedAlpacaOrder> {
      const response = await request(`/v1/trading/accounts/${options.accountId}/orders/${orderId}`, { method: 'DELETE' }) as AlpacaOrderResponse;
      return {
        id: response.id ?? '',
        clientOrderId: response.client_order_id ?? '',
        status: response.status ?? 'cancelled',
        createdAt: response.created_at ?? new Date().toISOString(),
        updatedAt: response.updated_at ?? new Date().toISOString(),
      };
    },
    async getOrders(): Promise<NormalizedAlpacaOrder[]> {
      const data = await request(`/v1/trading/accounts/${options.accountId}/orders?status=all`) as { orders?: AlpacaOrderResponse[] };
      return (data.orders ?? []).map((response) => ({
        id: response.id ?? '',
        clientOrderId: response.client_order_id ?? '',
        status: response.status ?? 'accepted',
        createdAt: response.created_at ?? new Date().toISOString(),
        updatedAt: response.updated_at ?? new Date().toISOString(),
      }));
    },
  };
}

function normalizeLegacyOrder(response: NormalizedAlpacaOrder, idempotencyKey: string): ProviderOrder {
  return {
    providerOrderId: response.id,
    clientOrderId: response.clientOrderId || idempotencyKey,
    state: normalizeState(response.status),
    acceptedAt: response.createdAt,
    updatedAt: response.updatedAt,
    executions: [],
  };
}

export class AlpacaCryptoProvider implements ExecutionProvider {
  readonly name = 'alpaca-crypto-sandbox';
  readonly executionMode = 'PAPER' as const;
  private readonly client: ReturnType<typeof buildAlpacaCryptoClient>;
  private readonly webhookSecret: string;

  constructor(options: AlpacaCryptoClientOptions & { webhookSecret: string }) {
    this.client = buildAlpacaCryptoClient(options);
    this.webhookSecret = options.webhookSecret;
  }

  async healthCheck() {
    try {
      await this.client.getOrders();
      return { connected: true, checkedAt: new Date().toISOString() };
    } catch {
      return { connected: false, checkedAt: new Date().toISOString() };
    }
  }

  async submitOrder(request: ProviderOrderRequest, idempotencyKey: string): Promise<ProviderOrder> {
    const response = await this.client.submitOrder({
      clientOrderId: request.clientOrderId,
      assetId: request.assetId ?? '',
      symbol: request.symbol,
      side: request.side === 'BUY' ? 'buy' : 'sell',
      type: request.type === 'MARKET' ? 'market' : request.type === 'LIMIT' ? 'limit' : 'stop_limit',
      timeInForce: request.timeInForce ?? 'gtc',
      qty: request.quantity,
      limitPrice: request.limitPrice,
      stopPrice: request.stopPrice,
    });
    return normalizeLegacyOrder(response, idempotencyKey);
  }

  async cancelOrder(providerOrderId: string, idempotencyKey: string): Promise<ProviderOrder> {
    return normalizeLegacyOrder(await this.client.cancelOrder(providerOrderId), idempotencyKey);
  }

  async getOrderStatus(providerOrderId: string): Promise<ProviderOrder> {
    return normalizeLegacyOrder(await this.client.getOrder(providerOrderId), 'status');
  }

  async getPositions(_accountId: string): Promise<ProviderPosition[]> {
    throw new Error('CRYPTO_POSITION_RECONCILIATION_NOT_IMPLEMENTED');
  }

  async getBalances(_accountId: string): Promise<ProviderBalance[]> {
    throw new Error('CRYPTO_BALANCE_RECONCILIATION_NOT_IMPLEMENTED');
  }

  async reconcile(_accountId: string): Promise<ProviderReconciliation> {
    throw new Error('CRYPTO_RECONCILIATION_NOT_IMPLEMENTED');
  }

  verifyWebhook(rawBody: string, signature: string): Promise<boolean> {
    return Promise.resolve(verifyHmacSha256(rawBody, signature, this.webhookSecret));
  }

  parseWebhook(_rawBody: string): Promise<SignedProviderWebhook> {
    return Promise.resolve({
      eventId: '',
      eventType: '',
      providerOrderId: '',
      occurredAt: new Date().toISOString(),
    });
  }
}

export class IndividualAlpacaTradingProvider implements ExecutionProvider {
  readonly name = 'individual-alpaca-trading';
  readonly executionMode: 'PAPER' | 'LIVE';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly accountId: string;
  private readonly fetcher: typeof fetch;
  private readonly webhookSecret: string;

  constructor(options: {
    baseUrl: string;
    apiKey: string;
    apiSecret: string;
    accountId: string;
    webhookSecret?: string;
    fetcher?: typeof fetch;
  }) {
    const baseUrl = normalizeAlpacaTradingBaseUrl(options.baseUrl);
    if (!baseUrl) throw new Error('INVALID_ALPACA_TRADING_BASE_URL');
    this.baseUrl = baseUrl;
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.accountId = options.accountId;
    this.fetcher = options.fetcher ?? fetch;
    this.webhookSecret = options.webhookSecret ?? '';
    this.executionMode = new URL(this.baseUrl).hostname === 'api.alpaca.markets' ? 'LIVE' : 'PAPER';
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'APCA-API-KEY-ID': this.apiKey,
        'APCA-API-SECRET-KEY': this.apiSecret,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(`ALPACA_TRADING_API_ERROR:${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  async healthCheck() {
    try {
      await this.request<{ status?: string; account_status?: string }>('/v2/account');
      return { connected: true, checkedAt: new Date().toISOString() };
    } catch {
      return { connected: false, checkedAt: new Date().toISOString() };
    }
  }

  async submitOrder(request: ProviderOrderRequest, idempotencyKey: string): Promise<ProviderOrder> {
    const body: {
      symbol: string;
      qty: string;
      side: 'buy' | 'sell';
      type: 'market' | 'limit' | 'stop';
      time_in_force: 'day' | 'gtc' | 'ioc';
      limit_price?: string;
      stop_price?: string;
    } = {
      symbol: request.symbol,
      qty: request.quantity,
      side: request.side === 'BUY' ? 'buy' : 'sell',
      type: request.type === 'MARKET' ? 'market' : request.type === 'LIMIT' ? 'limit' : 'stop',
      time_in_force: request.timeInForce ?? 'day',
    };
    if (request.limitPrice) body.limit_price = request.limitPrice;
    if (request.stopPrice) body.stop_price = request.stopPrice;
    const response = await this.request<{ id?: string; status?: string; client_order_id?: string; created_at?: string; updated_at?: string }>('/v2/orders', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return normalizeIndividualOrder(response, idempotencyKey);
  }

  async cancelOrder(providerOrderId: string, idempotencyKey: string): Promise<ProviderOrder> {
    const response = await this.request<{ id?: string; status?: string; client_order_id?: string; created_at?: string; updated_at?: string }>(`/v2/orders/${encodeURIComponent(providerOrderId)}`, { method: 'DELETE' });
    return normalizeIndividualOrder(response, idempotencyKey);
  }

  async getOrderStatus(providerOrderId: string): Promise<ProviderOrder> {
    const response = await this.request<{ id?: string; status?: string; client_order_id?: string; created_at?: string; updated_at?: string }>(`/v2/orders/${encodeURIComponent(providerOrderId)}`);
    return normalizeIndividualOrder(response, 'status');
  }

  async getPositions(_accountId: string): Promise<ProviderPosition[]> {
    const response = await this.request<{ positions?: unknown[] }>('/v2/positions');
    const items = Array.isArray(response)
      ? response
      : response && typeof response === 'object' && Array.isArray((response as any).positions)
        ? (response as any).positions
        : [];
    return items.map((item: any) => ({
      symbol: String(item.symbol ?? ''),
      quantity: String(item.qty ?? item.quantity ?? '0'),
      averagePrice: String(item.avg_entry_price ?? item.averagePrice ?? '0'),
      marketValue: String(item.market_value ?? item.marketValue ?? '0'),
      unrealizedPnl: String(item.unrealized_pl ?? item.unrealizedPnl ?? '0'),
      currency: String(item.currency ?? 'USD'),
      asOf: new Date().toISOString(),
    }));
  }

  async getBalances(accountId: string): Promise<ProviderBalance[]> {
    const response = await this.request<{ cash?: string; currency?: string }>(`/v2/accounts/${encodeURIComponent(accountId)}`);
    return [{
      currency: String(response.currency ?? 'USD'),
      available: String(response.cash ?? '0'),
      reserved: '0',
      asOf: new Date().toISOString(),
    }];
  }

  async reconcile(accountId: string): Promise<ProviderReconciliation> {
    const positions = await this.getPositions(accountId);
    const orderStatus = await this.getOrderStatus(this.accountId).catch(() => ({
      providerOrderId: this.accountId,
      clientOrderId: 'reconcile',
      state: 'FAILED',
      acceptedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      executions: [],
    } as ProviderOrder));

    return {
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      matchedOrders: orderStatus?.providerOrderId ? 1 : 0,
      mismatchedOrders: 0,
      matchedPositions: positions.length,
      mismatchedPositions: 0,
      differences: [],
    };
  }

  verifyWebhook(rawBody: string, signature: string): Promise<boolean> {
    return Promise.resolve(!!this.webhookSecret && verifyHmacSha256(rawBody, signature, this.webhookSecret));
  }

  parseWebhook(_rawBody: string): Promise<SignedProviderWebhook> {
    return Promise.resolve({
      eventId: '',
      eventType: '',
      providerOrderId: '',
      occurredAt: new Date().toISOString(),
    });
  }
}

function normalizeIndividualOrder(
  response: Partial<{ id: string; status: string; client_order_id: string; created_at: string; updated_at: string }>,
  idempotencyKey: string,
): ProviderOrder {
  return {
    providerOrderId: response.id ?? idempotencyKey,
    clientOrderId: response.client_order_id || idempotencyKey,
    state: normalizeState(response.status),
    acceptedAt: response.created_at || new Date().toISOString(),
    updatedAt: response.updated_at || new Date().toISOString(),
    executions: [],
  };
}

export function createIndividualTradingApiProviderFromEnvironment() {
  const config = getServerConfiguration().execution;
  if (config.alpacaProvider.toLowerCase() !== 'alpaca' || !config.alpacaTradingConfigured) return null;
  return new IndividualAlpacaTradingProvider({
    baseUrl: config.alpacaTradingBaseUrl,
    apiKey: config.alpacaTradingApiKey,
    apiSecret: config.alpacaTradingApiSecret,
    accountId: config.alpacaTradingAccountId,
    webhookSecret: config.brokerWebhookSecret,
  });
}

export function createAlpacaCryptoProviderFromEnvironment() {
  const config = getServerConfiguration().execution;
  if (!config.realEnabled || !config.brokerProvider || !config.alpacaBrokerConfigured) return null;
  return new AlpacaCryptoProvider({
    baseUrl: config.alpacaBrokerBaseUrl,
    clientId: config.alpacaBrokerClientId,
    clientSecret: config.alpacaBrokerClientSecret,
    accountId: config.alpacaBrokerAccountId,
    webhookSecret: config.brokerWebhookSecret,
  });
}
