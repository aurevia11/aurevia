import {afterEach,describe,expect,it,vi} from 'vitest';
import {
  getPublicConfiguration,
  getServerConfiguration,
  normalizeAlpacaTradingBaseUrl,
  validateServerConfiguration,
} from '../lib/config/env';

afterEach(()=>vi.unstubAllEnvs());

describe('canonical environment configuration',()=>{
  const source: Record<string,string|undefined> = {
    DATABASE_URL:'postgresql://user:test@example.invalid/db',
    DIRECT_URL:'postgresql://user:test@example.invalid/db',
    NEXTAUTH_SECRET:'test-secret-that-is-long-enough-for-auth',
    NEXTAUTH_URL:'https://app.example.invalid',
    NEXT_PUBLIC_APP_URL:'https://app.example.invalid',
    NEXT_PUBLIC_SUPABASE_URL:'https://project.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY:'public-anon-key',
    SUPABASE_SERVICE_ROLE_KEY:'private-service-key',
  };

  it('validates required server configuration without exposing secret values',()=>{
    const config=getServerConfiguration(source);
    const validation=validateServerConfiguration(config);

    expect(config.database.url).toContain('example.invalid');
    expect(config.auth.secret).toBe('test-secret-that-is-long-enough-for-auth');
    expect(config.database.directUrl).toContain('example.invalid');
    expect(validation).toEqual([]);
    expect(JSON.stringify(getPublicConfiguration(source))).not.toContain('private-service-key');
  });

  it('reports missing required values and malformed URLs with variable names only',()=>{
    const issues=validateServerConfiguration(getServerConfiguration({
      DATABASE_URL:'',
      DIRECT_URL:'not-a-url',
      NEXTAUTH_SECRET:'',
      NEXTAUTH_URL:'relative-url',
    }));

    expect(issues).toEqual(expect.arrayContaining([
      'DATABASE_URL is missing',
      'DIRECT_URL must be a valid PostgreSQL URL',
      'NEXTAUTH_SECRET is missing',
      'NEXTAUTH_URL must be a valid absolute HTTPS URL',
    ]));
  });

  it('rejects database URLs that target different databases',()=>{
    const config=getServerConfiguration({
      ...source,
      DIRECT_URL:'postgresql://user:test@example.invalid/other-db',
    });

    expect(validateServerConfiguration(config)).toContain('DATABASE_URL and DIRECT_URL must target the same database');
  });

  it('keeps public configuration limited to browser-safe values',()=>{
    vi.stubEnv('NEXT_PUBLIC_APP_URL','https://app.example.invalid');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://project.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY','public-anon-key');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','private-service-key');

    const publicConfig=getPublicConfiguration();

    expect(publicConfig.appUrl).toBe('https://app.example.invalid');
    expect(publicConfig.supabaseUrl).toBe('https://project.supabase.co');
    expect(publicConfig.supabaseAnonKey).toBe('public-anon-key');
    expect(JSON.stringify(publicConfig)).not.toContain('private-service-key');
  });

  it('detects optional integrations without requiring credentials',()=>{
    const config=getServerConfiguration({
      REAL_EXECUTION_ENABLED:'false',
      BROKER_PROVIDER:'',
      ALPACA_BROKER_BASE_URL:'https://broker-api.sandbox.alpaca.markets',
      ALPACA_BROKER_CLIENT_ID:'',
      ALPACA_BROKER_CLIENT_SECRET:'',
    });

    expect(config.execution.realEnabled).toBe(false);
    expect(config.execution.alpacaConfigured).toBe(false);
    expect(config.execution.provider).toBeNull();
    expect(config.smtp.configured).toBe(false);
    expect(config.marketData.configured).toBe(false);
  });

  it('uses the published support phone when no override is configured',()=>{
    expect(getServerConfiguration({}).smtp.supportPhone).toBe('+1 (210) 504-7697');
    expect(getServerConfiguration({SUPPORT_PHONE:'+1 555 010 1234'}).smtp.supportPhone).toBe('+1 555 010 1234');
  });

  it('keeps registration contact verification disabled unless explicitly enabled',()=>{
    expect(getServerConfiguration({}).verification.registrationVerificationEnabled).toBe(false);
    expect(getServerConfiguration({REGISTRATION_VERIFICATION_ENABLED:'true'}).verification.registrationVerificationEnabled).toBe(true);
  });

  it('accepts the Individual Trading API variable names without enabling real execution by default',()=>{
    const config=getServerConfiguration({
      REAL_EXECUTION_ENABLED:'false',
      ALPACA_PROVIDER:'alpaca',
      ALPACA_TRADING_BASE_URL:'https://paper-api.alpaca.markets',
      ALPACA_API_KEY:'paper-key',
      ALPACA_API_SECRET:'paper-secret',
      ALPACA_ACCOUNT_ID:'paper-account-id',
    });

    expect(config.execution.provider).toBe('alpaca');
    expect(config.execution.alpacaTradingConfigured).toBe(true);
    expect(config.execution.alpacaTradingBaseUrl).toBe('https://paper-api.alpaca.markets');
    expect(config.execution.alpacaTradingApiKey).toBe('paper-key');
    expect(config.execution.alpacaTradingApiSecret).toBe('paper-secret');
    expect(config.execution.alpacaTradingAccountId).toBe('paper-account-id');
    expect(config.execution.realEnabled).toBe(false);
  });

  it('normalizes only approved HTTPS Alpaca Trading API hosts',()=>{
    expect(normalizeAlpacaTradingBaseUrl(' https://PAPER-API.ALPACA.MARKETS/ ')).toBe('https://paper-api.alpaca.markets');
    expect(normalizeAlpacaTradingBaseUrl('https://paper-api.alpaca.markets/v2')).toBe('https://paper-api.alpaca.markets');
    expect(normalizeAlpacaTradingBaseUrl('https://api.alpaca.markets')).toBe('https://api.alpaca.markets');
    for(const url of ['http://paper-api.alpaca.markets','https://example.com','https://paper-api.alpaca.markets/path','https://paper-api.alpaca.markets/v2/account','https://user:pass@paper-api.alpaca.markets']){
      expect(normalizeAlpacaTradingBaseUrl(url)).toBeNull();
    }
  });

  it('consumes Finnhub credentials only in server configuration',()=>{
    const privateSource={FINNHUB_API_KEY:'server-only-finnhub-test-key',ALPACA_API_KEY:'server-only-alpaca-test-key',ALPACA_API_SECRET:'server-only-alpaca-secret',ALPACA_ACCOUNT_ID:'private-account-id'};
    const config=getServerConfiguration(privateSource);
    expect(config.marketData.finnhubApiKey).toBe('server-only-finnhub-test-key');
    const publicConfig=JSON.stringify(getPublicConfiguration(privateSource));
    for(const value of Object.values(privateSource))expect(publicConfig).not.toContain(value);
  });
});
