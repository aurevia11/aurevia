import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {PNG} from 'pngjs';
import {test,expect,loginAs,logout,waitForStartup,expectNoHorizontalOverflow} from './fixtures';
import {db} from '../../lib/db';
import {settleMaturedDemoInvestments} from '../../lib/demo-investment-settlement';

const viewports=[
	{width:320,height:800},
	{width:360,height:800},
	{width:375,height:812},
	{width:390,height:844},
	{width:393,height:852},
	{width:430,height:932},
	{width:414,height:896},
	{width:768,height:1024},
	{width:1024,height:900},
	{width:1280,height:900},
	{width:1440,height:900},
	{width:1920,height:1080},
];

const publicRoutes=['/','/login','/register','/markets','/client-stories','/about','/education','/support','/waitlist','/terms','/privacy','/risk-disclosure'];
const authenticatedRoutes=['/dashboard','/trade','/markets','/portfolio','/orders','/investments','/wallet','/wallet/transactions','/kyc','/tier','/settings','/support','/notifications'];
const adminRoutes=['/admin/login','/admin','/admin/investments','/admin/payments','/admin/support','/admin/tiers'];

function fixture(name:string){
	const value=process.env[`AUREVIA_E2E_${name}`];
	if(!value)throw new Error(`Playwright fixture ${name} is unavailable.`);
	return value;
}

async function typeInto(page:import('@playwright/test').Page,field:import('@playwright/test').Locator,value:string){
	await field.click();
	await expect.poll(()=>field.evaluate(element=>document.activeElement===element)).toBe(true);
	await page.keyboard.insertText(value);
	await expect(field).toHaveValue(value);
}

async function selectAccountMode(page:import('@playwright/test').Page,accountMode:'DEMO'|'REAL',options:{waitForCompletion?:boolean}={}){
	const mode=page.getByLabel('Account mode');
	await expect(mode).not.toHaveAttribute('aria-busy','true');
	if(!await mode.isVisible()){
		const menu=page.locator('.menu-button');
		if(await menu.getAttribute('aria-expanded')!=='true')await menu.click();
	}
	await expect(mode).toBeVisible();
	await mode.selectOption(accountMode);
	if(options.waitForCompletion!==false){
		await expect(mode).toHaveValue(accountMode);
		await expect(mode).toHaveAttribute('aria-busy','false');
	}
}

test.describe('public routes and responsive layout',()=>{
	for(const viewport of viewports){
		test(`public routes render without horizontal overflow at ${viewport.width}x${viewport.height}`,async({page})=>{
			await page.setViewportSize(viewport);
			for(const route of publicRoutes){
				const response=await page.goto(route);
				expect(response?.status(),route).toBe(200);
				await expect(page.locator('h1').first(),route).toBeVisible();
				if(route==='/markets')await expect(page.getByRole('heading',{name:'Mercados',exact:true})).toBeVisible();
				if(route==='/support')await expect(page.getByRole('heading',{name:'Nova AI',exact:true})).toBeVisible();
				if(route==='/register'){
					await expect(page.getByRole('radio',{name:/DEMO ACCOUNT/})).toBeVisible();
					await expect(page.getByRole('radio',{name:/REAL ACCOUNT/})).toBeVisible();
				}
				await expectNoHorizontalOverflow(page);
			}
		});
	}
});

test('full-screen 3D market model renders on desktop and mobile',async({page})=>{
	for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
		await page.setViewportSize(viewport);
		await page.goto('/');
		await waitForStartup(page);
		const canvas=page.locator('.home-market-depth .market-depth-canvas canvas');
		await expect(canvas).toBeVisible();
		const image=PNG.sync.read(await canvas.screenshot());
		let visiblePixels=0;
		for(let index=0;index<image.data.length;index+=4){
			if(image.data[index+3]>4&&image.data[index]+image.data[index+1]+image.data[index+2]>24)visiblePixels++;
		}
		expect(visiblePixels,`3D canvas should render visible pixels at ${viewport.width}px`).toBeGreaterThan(20);
		await page.screenshot({path:`/tmp/aurevia-market-depth-${viewport.width}.png`});
		await expectNoHorizontalOverflow(page);
	}
});

test('floating support launcher can be dragged horizontally and vertically',async({page})=>{
	await page.setViewportSize({width:1440,height:900});
	await page.goto('/');
	await waitForStartup(page);
	const launcher=page.getByRole('button',{name:'Open chat support'});
	const initial=await launcher.boundingBox();
	expect(initial).not.toBeNull();
	if(!initial)return;
	await page.mouse.move(initial.x+28,initial.y+28);
	await page.mouse.down();
	await page.mouse.move(160,220,{steps:12});
	await page.mouse.up();
	const moved=await launcher.boundingBox();
	expect(moved).not.toBeNull();
	if(!moved)return;
	expect(Math.abs(moved.x-initial.x)).toBeGreaterThan(100);
	expect(Math.abs(moved.y-initial.y)).toBeGreaterThan(100);
	await expect(launcher).toBeVisible();
});

test('Vercel scheduled market tick requires its secret and advances simulated prices',async({page})=>{
	const unauthorized = await page.request.get('/api/cron/market-tick');
	expect(unauthorized.status()).toBe(401);
	const authorized = await page.request.get('/api/cron/market-tick', { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
	expect(authorized.status()).toBe(200);
	expect(await authorized.json()).toMatchObject({ ok: true, updated: expect.any(Number) });
});

test('waitlist form submits and shows a truthful success state',async({page})=>{
	await page.setViewportSize({ width: 375, height: 812 });
	await page.goto('/waitlist');
	await expect(page.locator('.waitlist-page')).toHaveAttribute('data-waitlist-ready', 'true');
	await waitForStartup(page);
	const waitlistName = page.locator('.waitlist-form input[autocomplete="name"]');
	const waitlistEmail = page.locator('.waitlist-form input[autocomplete="email"]');
	await waitlistName.fill('Temporary E2E Waitlist');
	await expect(waitlistName).toHaveValue('Temporary E2E Waitlist');
	const email = `waitlist-${randomUUID()}@example.invalid`;
	await waitlistEmail.fill(email);
	await expect(waitlistEmail).toHaveValue(email);
	await page.locator('.waitlist-form select').first().selectOption('US');
	await page.locator('.waitlist-form input[type="checkbox"]').check();
	await page.getByRole('button', { name: /Join (the )?waitlist/i }).click();
	await expect(page.locator('.waitlist-success')).toContainText(/waitlist|access|request/i);
	await expect(page.locator('.waitlist-page')).not.toContainText(/position\s*#?\d+/i);
	await expectNoHorizontalOverflow(page);
});

test('mobile navigation opens and navigates to Login',async({page})=>{
	await page.setViewportSize({width:320,height:800});
	await page.goto('/');
	await page.getByRole('button',{name:'Open navigation'}).click();
	const nav=page.getByRole('navigation',{name:'Primary navigation'});
	await expect(nav).toBeVisible();
	const firstLink=nav.getByRole('link').first();
	await expect.poll(()=>firstLink.evaluate(element=>{
		const bounds=element.getBoundingClientRect();
		const target=document.elementFromPoint(bounds.left+bounds.width/2,bounds.top+bounds.height/2);
		return target===element||element.contains(target);
	})).toBe(true);
	await page.getByRole('button',{name:'Close navigation'}).click();
	await expect(page.getByRole('button',{name:'Open navigation'})).toHaveAttribute('aria-expanded','false');
	await page.getByRole('button',{name:'Open navigation'}).click();
	await nav.getByRole('link',{name:'Sign in'}).click();
	await expect(page).toHaveURL(/\/login$/);
	await expect(page.getByRole('heading',{name:'Welcome back'})).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('login and registration fields receive real pointer and keyboard input',async({page})=>{
	await page.setViewportSize({width:390,height:844});
	await page.goto('/login');
	await waitForStartup(page);
	const identifier=page.getByLabel('Email or administrator username');
	const password=page.getByLabel('Password',{exact:true});
	await typeInto(page,identifier,'invalid-user@example.test');
	await typeInto(page,password,'NotARealPassword123!');
	await page.getByRole('button',{name:'Show password'}).click();
	await expect(password).toHaveAttribute('type','text');
	await expect(password).toHaveValue('NotARealPassword123!');
	await page.getByRole('button',{name:'Hide password'}).click();
	await page.getByRole('button',{name:'Sign in'}).click();
	await expect(page.locator('.auth-error[role="alert"]')).toContainText(/sign-in failed/i);
	await expect(identifier).toHaveValue('invalid-user@example.test');

	await page.goto('/register');
	await waitForStartup(page);
	await typeInto(page,page.getByLabel('First name'),'Browser');
	await typeInto(page,page.getByLabel('Last name'),'Input Test');
	const dateOfBirth=page.getByLabel('Date of birth');
	await dateOfBirth.click();
	await expect.poll(()=>dateOfBirth.evaluate(element=>document.activeElement===element)).toBe(true);
	await dateOfBirth.fill('1990-01-01');
	await expect(dateOfBirth).toHaveValue('1990-01-01');
	await typeInto(page,page.getByLabel('Email address'),'input-test@example.test');
	await typeInto(page,page.getByLabel(/Phone number/),'2025550100');
	await typeInto(page,page.getByLabel('Password',{exact:true}),'ValidPassword123!');
	await typeInto(page,page.getByLabel('Confirm password'),'ValidPassword123!');
	await page.getByRole('radio',{name:/REAL ACCOUNT/}).click();
	await expect(page.getByRole('radio',{name:/REAL ACCOUNT/})).toBeChecked();
	await page.getByRole('checkbox').check();
	await expect(page.getByRole('checkbox')).toBeChecked();
	await expectNoHorizontalOverflow(page);
});

test('dashboard hierarchy remains usable and contained at mobile and desktop widths',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	for(const width of [320,375,390,430,1440]){
		await page.setViewportSize({width,height:900});
		await page.goto('/dashboard');
		await expect(page.getByRole('heading',{name:/Hello,/})).toBeVisible();
		await expect(page.locator('.dashboard-metric')).toHaveCount(6);
		await expect(page.locator('.dashboard-panel')).toHaveCount(6);
		await expectNoHorizontalOverflow(page);
		const layout=await page.evaluate(()=>{
			const metrics=document.querySelector('.dashboard-metrics');
			const panels=[...document.querySelectorAll('.dashboard-panel')].map(panel=>{
				const rect=panel.getBoundingClientRect();
				return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom};
			});
			return {metricColumns:getComputedStyle(metrics!).gridTemplateColumns.split(' ').length,panels};
		});
		expect(layout.metricColumns).toBe(width<1024?2:3);
		for(let index=0;index<layout.panels.length;index++){
			for(let other=index+1;other<layout.panels.length;other++){
				const a=layout.panels[index],b=layout.panels[other];
				const overlaps=a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1;
				expect(overlaps,`dashboard panels ${index} and ${other} overlap at ${width}px`).toBe(false);
			}
		}
	}
	await page.setViewportSize({width:390,height:844});
	await expect(page.locator('.dashboard-profile-panel')).toBeVisible();
	await expect(page.getByRole('link',{name:'Edit Profile'})).toBeVisible();
	await expect(page.locator('.dashboard-profile-panel')).toContainText('Temporary E2E User');
	await expect(page.getByRole('link',{name:'Open Notifications'})).toBeVisible();
});

test('authenticated desktop navigation opens without overflow and closes after navigation',async({page})=>{
	await page.setViewportSize({width:1280,height:900});
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	const menu=page.locator('.menu-button');
	await menu.click();
	const navigation=page.getByRole('navigation',{name:'Primary navigation'});
	await expect(navigation).toBeVisible();
	await expect(menu).toHaveAttribute('aria-expanded','true');
	await expect(navigation.getByRole('heading',{name:/investing/i})).toBeVisible();
	await expect(navigation.getByRole('heading',{name:/account & support/i})).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await navigation.getByRole('link',{name:'Notifications'}).click();
	await expect(page).toHaveURL(/\/notifications/);
	await expect(menu).toHaveAttribute('aria-expanded','false');
});

test('global chat support persists its position and exchanges private admin messages',async({browser,page})=>{
	await page.setViewportSize({width:390,height:844});
	await page.goto('/login');
	const launcher=page.getByRole('button',{name:'Open chat support'});
	await expect(launcher).toBeVisible();
	await launcher.click();
	await expect(page.getByText('Sign in to send a private message to admin support.')).toBeVisible();
	await page.getByRole('button',{name:'Close chat support'}).click();
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	const floatingLauncher=page.getByRole('button',{name:'Open chat support'});
	const before=await floatingLauncher.boundingBox();
	expect(before).not.toBeNull();
	await page.mouse.move(before!.x+before!.width/2,before!.y+before!.height/2);
	await page.mouse.down();
	await page.mouse.move(190,180,{steps:5});
	await page.mouse.up();
	const moved=await floatingLauncher.boundingBox();
	expect(moved).not.toBeNull();
	expect(Math.abs(moved!.x-before!.x)+Math.abs(moved!.y-before!.y)).toBeGreaterThan(40);
	await page.goto('/markets');
	const afterNavigation=await page.getByRole('button',{name:'Open chat support'}).boundingBox();
	expect(afterNavigation).not.toBeNull();
	expect(afterNavigation!.x).toBeCloseTo(moved!.x,0);
	expect(afterNavigation!.y).toBeCloseTo(moved!.y,0);
	await page.getByRole('button',{name:'Open chat support'}).click();
	const subject=`Floating support ${randomUUID().slice(0,8)}`;
	await page.getByLabel('Subject').fill(subject);
	await page.getByLabel('Message').fill('Please have an administrator reply to this private support request.');
	await page.getByRole('button',{name:'Send to admin'}).click();
	await expect(page.locator('.floating-support-notice')).toContainText('sent to the admin support inbox');
	const conversations=await page.request.get('/api/support').then(response=>response.json());
	const conversation=conversations.find((item:{subject:string})=>item.subject===subject);
	expect(conversation).toBeTruthy();
	const adminContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const inbox=await adminPage.request.get('/api/admin/support').then(response=>response.json());
		expect(inbox.some((item:{id:string})=>item.id===conversation.id)).toBe(true);
		const response=await adminPage.request.patch('/api/admin/support',{data:{action:'reply',conversationId:conversation.id,message:'Admin reply from the isolated end-to-end test.'}});
		expect(response.ok()).toBe(true);
	}finally{await adminContext.close()}
	await page.getByRole('button',{name:'Close chat support'}).click();
	await page.getByRole('button',{name:'Open chat support'}).click();
	await expect(page.locator('.floating-support-messages')).toContainText('Admin reply from the isolated end-to-end test.');
	await expectNoHorizontalOverflow(page);
});

test('language selection persists Arabic RTL direction and remains responsive',async({page})=>{
	await page.setViewportSize({width:390,height:844});
	await page.goto('/');
	const languageTrigger=page.getByRole('button',{name:/Select language:/});
	await languageTrigger.click();
	await page.getByRole('menuitemradio',{name:/العربية/}).click();
	await expect(page.locator('html')).toHaveAttribute('lang','ar');
	await expect(page.locator('html')).toHaveAttribute('dir','rtl');
	await expect.poll(()=>page.evaluate(()=>localStorage.getItem('aurevia-locale'))).toBe('ar');
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('lang','ar');
	await expect(page.locator('html')).toHaveAttribute('dir','rtl');
	await expectNoHorizontalOverflow(page);
});

test('language selector supports keyboard navigation, outside dismissal, and focus restoration',async({page})=>{
	await page.setViewportSize({width:320,height:800});
	await page.goto('/');
	const trigger=page.getByRole('button',{name:/Select language:/});
	await trigger.focus();
	await page.keyboard.press('ArrowDown');
	const menu=page.getByRole('menu',{name:/Languages/});
	await expect(menu).toBeVisible();
	await expect(menu.getByRole('menuitemradio').first()).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(menu).toBeHidden();
	await expect(trigger).toBeFocused();
	await trigger.click();
	await page.locator('body').click({position:{x:5,y:5}});
	await expect(menu).toBeHidden();
	await expect(trigger).not.toBeFocused();
	await expectNoHorizontalOverflow(page);
});

test('startup releases page interaction if session initialization is delayed',async({page})=>{
	let releaseSession!:()=>void;
	const sessionGate=new Promise<void>(resolve=>{releaseSession=resolve});
	await page.route('**/api/auth/session',async route=>{
		await sessionGate;
		await route.fulfill({status:200,contentType:'application/json',body:'{}'});
	});
	await page.goto('/login');
	const startup=page.getByRole('status',{name:'Loading Aurevia Invest'});
	await expect(startup).toBeVisible();
	await expect(startup).toBeHidden({timeout:5000});
	const email=page.getByLabel('Email or administrator username');
	await email.fill('qa@example.invalid');
	await expect(email).toHaveValue('qa@example.invalid');
	await expect(page.locator('.scene-content > div[inert]')).toHaveCount(0);
	releaseSession();
	await expect(page.getByRole('heading',{name:'Welcome back'})).toBeVisible();
	await page.getByRole('link',{name:'Create an account'}).click();
	await expect(page.getByRole('heading',{name:'Open an account'})).toBeVisible();
	await expect(startup).toBeHidden();
	await page.goBack();
	await expect(page.getByRole('heading',{name:'Welcome back'})).toBeVisible();
	await page.reload();
	await expect(page.getByRole('heading',{name:'Welcome back'})).toBeVisible();
	await expect(startup).toBeHidden();
});

test('market refresh runs in place without reloading the page',async({page})=>{
	let documentRequests=0;
	let quoteRequests=0;
	let historyRequests=0;
	page.on('request',request=>{if(request.resourceType()==='document')documentRequests++});
	await page.route(/\/api\/live-markets\?symbols=/,route=>{
		quoteRequests++;
		return route.fulfill({status:200,contentType:'application/json',body:'{"quotes":[],"source":"isolated UI test"}'});
	});
	await page.route(/\/api\/live-markets\/[^?]+\?timeframe=/,async route=>{
		const timeframe=new URL(route.request().url()).searchParams.get('timeframe');
		historyRequests++;
		await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({quote:null,candles:[],timeframe,interval:'1m'})});
	});
	await page.goto('/markets');
	await waitForStartup(page);
	const beforeRetry=documentRequests;
	await expect.poll(()=>historyRequests).toBeGreaterThan(0);
	const priorQuotes=quoteRequests;
	const priorHistory=historyRequests;
	await page.getByRole('button',{name:'Actualizar cotizaciones'}).click();
	await expect.poll(()=>quoteRequests).toBeGreaterThan(priorQuotes);
	await expect.poll(()=>historyRequests).toBeGreaterThan(priorHistory);
	expect(documentRequests).toBe(beforeRetry);
});

test('watchlists persist across refresh and remain isolated between accounts',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/markets');
	const sidebar=page.getByRole('complementary',{name:'Listas de seguimiento'});
	await expect(sidebar).toHaveAttribute('aria-busy','false');
	await page.getByRole('button',{name:'Crear lista de seguimiento'}).click();
	await page.getByLabel('Nombre de la nueva lista').fill('User A private list');
	await page.getByRole('button',{name:'Guardar lista'}).click();
	await page.getByRole('button',{name:/Añadir símbolo/}).click();
	await page.getByLabel('Buscar símbolo para añadir').fill('AAPL');
	await page.locator('.live-symbol-results').getByRole('button').filter({hasText:'AAPL'}).click();
	await expect(page.locator('.live-watch-row').filter({hasText:'AAPL'})).toBeVisible();
	await page.reload();
	await expect(sidebar).toHaveAttribute('aria-busy','false');
	await expect(page.locator('#watchlist-select option',{hasText:'User A private list'})).toHaveCount(1);
	await expect(page.locator('.live-watch-row').filter({hasText:'AAPL'})).toBeVisible();

	await logout(page);
	await loginAs(page,fixture('LEGACY_USER_EMAIL'),fixture('LEGACY_USER_PASSWORD'));
	await page.goto('/markets');
	await expect(sidebar).toHaveAttribute('aria-busy','false');
	await expect(page.locator('#watchlist-select option',{hasText:'User A private list'})).toHaveCount(0);
	await expect(page.locator('.live-watch-row').filter({hasText:'AAPL'})).toHaveCount(0);

	await logout(page);
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/markets');
	await expect(sidebar).toHaveAttribute('aria-busy','false');
	await expect(page.locator('#watchlist-select option',{hasText:'User A private list'})).toHaveCount(1);
	await expect(page.locator('.live-watch-row').filter({hasText:'AAPL'})).toBeVisible();
});

test('country selector searches Nigeria and United Kingdom and shows their dialing codes',async({page})=>{
	await page.setViewportSize({width:320,height:800});
	await page.goto('/register');
	const picker=page.getByRole('button',{name:/phone country and dialing code/i});
	await expect(picker).toHaveAttribute('aria-label',/United States \+1/);
	await picker.click();
	const dialog=page.getByRole('dialog',{name:'Select phone country and dialing code'});
	await expect(dialog).toBeVisible();
	await expectNoHorizontalOverflow(page);
	const search=dialog.getByRole('searchbox');
	await search.fill('Nigeria');
	const nigeria=dialog.getByRole('option',{name:/Nigeria.*NG.*\+234/});
	await expect(nigeria).toBeVisible();
	await search.press('ArrowDown');
	await expect(nigeria).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(picker).toHaveAttribute('aria-label',/Nigeria \+234/);
	await picker.click();
	const ukDialog=page.getByRole('dialog',{name:'Select phone country and dialing code'});
	await ukDialog.getByRole('searchbox').fill('United Kingdom');
	const uk=ukDialog.getByRole('option',{name:/United Kingdom.*GB.*\+44/});
	await expect(uk).toBeVisible();
	await uk.click();
	await expect(picker).toHaveAttribute('aria-label',/United Kingdom \+44/);
	await expectNoHorizontalOverflow(page);
});

test('mobile date entry is calendar-backed and future dates are blocked',async({page})=>{
	await page.setViewportSize({width:320,height:800});
	await page.goto('/register');
	const date=page.getByLabel('Date of birth');
	await expect(date).toHaveAttribute('type','date');
	await expect(date).toHaveAttribute('max',new Date().toISOString().slice(0,10));
	const future=new Date();future.setUTCDate(future.getUTCDate()+1);
	const futureDate=future.toISOString().slice(0,10);
	await date.fill(futureDate);
	await expect(date).toHaveValue(futureDate);
	const rejectsFuture=await date.evaluate((input:HTMLInputElement)=>input.validity.rangeOverflow);
	expect(rejectsFuture).toBe(true);
	await expectNoHorizontalOverflow(page);
});

test('sign-in password visibility, recovery link, and account link are accessible on mobile',async({page})=>{
	await page.setViewportSize({width:320,height:800});
	await page.goto('/login');
	const password=page.getByLabel('Password',{exact:true});
	await password.fill('ExamplePassword123');
	await page.getByRole('button',{name:'Show password'}).click();
	await expect(password).toHaveAttribute('type','text');
	await page.getByRole('button',{name:'Hide password'}).click();
	await expect(password).toHaveAttribute('type','password');
	await expect(page.getByRole('link',{name:'Forgot password?'})).toHaveAttribute('href','/forgot-password');
	await expect(page.getByRole('link',{name:'Create an account'})).toHaveAttribute('href','/register');
	await expectNoHorizontalOverflow(page);
});

test('registration skips contact verification and platform health remains available after logout',async({page})=>{
	const email=fixture('REGISTRATION_EMAIL');
	const password=fixture('REGISTRATION_PASSWORD');
	await page.request.post('http://127.0.0.1:4311/reset');
	await page.goto('/register');
	await expect(page.getByRole('heading',{name:'Open an account'})).toBeVisible();
	await expect(page.getByRole('radio',{name:/DEMO ACCOUNT/})).toBeVisible();
	const realMode=page.getByRole('radio',{name:/REAL ACCOUNT/});
	await realMode.check();
	await expect(realMode).toBeChecked();
	const demoMode=page.getByRole('radio',{name:/DEMO ACCOUNT/});
	await demoMode.check();
	await expect(demoMode).toBeChecked();
	await page.getByLabel('First name').fill('Temporary');
	await page.getByLabel('Last name').fill('Browser Test');
	await page.getByLabel('Date of birth').fill('2000-02-29');
	const residencePicker=page.getByRole('button',{name:/country of residence/i});
	await residencePicker.click();
	const residenceDialog=page.getByRole('dialog',{name:'Select country of residence'});
	await residenceDialog.getByRole('searchbox').fill('United States');
	await residenceDialog.getByRole('option',{name:/United States.*US.*\+1/}).click();
	const phonePicker=page.getByRole('button',{name:/phone country and dialing code/i});
	await phonePicker.click();
	const phoneDialog=page.getByRole('dialog',{name:'Select phone country and dialing code'});
	await phoneDialog.getByRole('searchbox').fill('United Kingdom');
	await phoneDialog.getByRole('option',{name:/United Kingdom.*GB.*\+44/}).click();
	await page.getByLabel('Email address').fill(email);
	await page.getByLabel(/Phone number/).fill('07400 123456');
	await page.getByLabel('Password', {exact:true}).fill(password);
	await page.getByLabel('Confirm password').fill(password);
	await page.getByRole('checkbox').check();
	const registrationRequest=page.waitForRequest(request=>request.url().endsWith('/api/register')&&request.method()==='POST');
	await page.getByRole('button',{name:'Create account'}).click();
	const registrationPayload=(await registrationRequest).postDataJSON();
	expect(registrationPayload).toMatchObject({name:'Temporary Browser Test',country:'United States',phone:'+447400123456',dateOfBirth:'2000-02-29'});
	await expect(page).toHaveURL(/\/login\?registered=1/);
	const providerStats=await page.request.get('http://127.0.0.1:4311/stats');
	expect(await providerStats.json()).toMatchObject({email:0,sms:0});
	await page.getByLabel('Email or administrator username').fill(email);
	await page.getByLabel('Password',{exact:true}).fill(password);
	await page.getByRole('button',{name:'Sign in'}).click();
	await page.waitForURL(/dashboard/);
	await expect(page.getByRole('heading',{name:'Hello, Temporary'})).toBeVisible();
	await expect(page.locator('.dashboard-profile-panel')).toContainText('Temporary Browser Test');
	await page.goto('/settings');
	await expect(page.getByRole('tab',{name:'Profile'})).toBeVisible();
	await expect(page.getByLabel('Email address')).toHaveValue(email);
	await page.getByLabel('First name').fill('Edited');
	await page.getByLabel('Last name').fill('Persistent Owner');
	await page.getByLabel('Phone').fill('+447400123457');
	await page.getByLabel('Country').fill('United Kingdom');
	await page.getByLabel('Address (optional)').fill('42 Persistent Test Road');
	const profilePatchRequest=page.waitForRequest(request=>request.url().endsWith('/api/profile')&&request.method()==='PATCH');
	const profilePatchResponse=page.waitForResponse(response=>response.url().endsWith('/api/profile')&&response.request().method()==='PATCH');
	await page.getByRole('button',{name:'Save profile'}).click();
	const patchRequest=await profilePatchRequest;
	const patchResponse=await profilePatchResponse;
	expect(patchRequest.postDataJSON()).toMatchObject({firstName:'Edited',lastName:'Persistent Owner',phone:'+447400123457',country:'United Kingdom',address:'42 Persistent Test Road'});
	expect(await patchResponse.json()).toMatchObject({name:'Edited Persistent Owner',firstName:'Edited',lastName:'Persistent Owner',phone:'+447400123457',country:'United Kingdom',address:'42 Persistent Test Road'});
	await expect(page.getByRole('status')).toContainText('Profile saved successfully.');
	await page.reload();
	await expect(page.getByLabel('First name')).toHaveValue('Edited');
	await expect(page.getByLabel('Last name')).toHaveValue('Persistent Owner');
	await expect(page.getByLabel('Phone')).toHaveValue('+447400123457');
	await expect(page.getByLabel('Country')).toHaveValue('United Kingdom');
	await expect(page.getByLabel('Address (optional)')).toHaveValue('42 Persistent Test Road');
	await page.goto('/dashboard');
	await expect(page.getByRole('heading',{name:'Hello, Edited'})).toBeVisible();
	const profileResponse=await page.request.get('/api/profile');
	expect(profileResponse.ok()).toBeTruthy();
	const profile=await profileResponse.json();
	expect(profile).toMatchObject({name:'Edited Persistent Owner',firstName:'Edited',lastName:'Persistent Owner',phone:'+447400123457',country:'United Kingdom',address:'42 Persistent Test Road'});
	expect(profile.phoneVerified).toBe(false);
	expect(profile).not.toHaveProperty('dob');
	expect(profile).not.toHaveProperty('dateOfBirth');
	const kycResponse=await page.request.get('/api/kyc');
	expect((await kycResponse.json()).dob).toBe('2000-02-29T00:00:00.000Z');
	const demoWallet=await page.request.get('/api/wallet');
	expect(Number((await demoWallet.json()).balance)).toBe(5000);
	await selectAccountMode(page,'REAL');
	await page.goto('/dashboard');
	await expect(page.getByRole('heading',{name:'Hello, Edited'})).toBeVisible();
	await expect(page.locator('.dashboard-real-state')).toBeVisible();
	await expect.poll(async()=>Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(0);
	await selectAccountMode(page,'DEMO');
	await page.goto('/dashboard');
	await expect(page.getByRole('heading',{name:'Hello, Edited'})).toBeVisible();
	await expect(page.locator('.dashboard-real-state')).toHaveCount(0);
	await expect.poll(async()=>Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(5000);
	await logout(page);
	const healthAfterLogout=await page.request.get('/api/health');
	expect(healthAfterLogout.ok()).toBeTruthy();
	expect(await healthAfterLogout.json()).toMatchObject({ok:true,database:'ok'});
	await loginAs(page,email,password);
	await expect(page.getByRole('heading',{name:'Hello, Edited'})).toBeVisible();
	expect(await page.request.get('/api/profile').then(response=>response.json())).toMatchObject({name:'Edited Persistent Owner',address:'42 Persistent Test Road'});
	await page.goto('/');
	await expect(page.getByRole('link',{name:/Dashboard/}).first()).toBeVisible();
	await expect(page.getByRole('button',{name:/Notifications/})).toBeVisible();
	await expect(page.getByRole('link',{name:'Login'})).toHaveCount(0);
	await page.reload();
	await expect(page.getByRole('button',{name:/Notifications/})).toBeVisible();
	await logout(page);
	await expect(page).toHaveURL(/\/login/);
	await page.goto('/');
	await page.getByRole('button',{name:'Open navigation'}).click();
	const primaryNavigation=page.getByRole('navigation',{name:'Primary navigation'});
	await expect(primaryNavigation.getByRole('link',{name:'Sign in',exact:true})).toBeVisible();
	await expect(primaryNavigation.getByRole('link',{name:'Create an account',exact:true})).toBeVisible();
	await expect(page.getByRole('link',{name:'Open account',exact:true}).first()).toBeVisible();
});

test('legacy account without registration verification metadata can still sign in',async({page})=>{
	await loginAs(page,fixture('LEGACY_USER_EMAIL'),fixture('LEGACY_USER_PASSWORD'));
	await expect(page.getByRole('heading',{name:'Hello, Legacy'})).toBeVisible();
	await expect(page.getByRole('button',{name:/Notifications/})).toBeVisible();
});

test('session replacement is explicit and refresh-safe',async({page,browser})=>{
	const email=fixture('USER_EMAIL');
	const password=fixture('USER_PASSWORD');
	await page.goto('/login');
	await waitForStartup(page);
	await page.getByLabel('Email or administrator username').fill(email);
	await page.getByLabel('Password',{exact:true}).fill(password);
	await page.getByRole('checkbox',{name:/Replace the active Aurevia session/}).check();
	await page.getByRole('button',{name:'Sign in'}).click();
	await page.waitForURL(/dashboard/);
	await page.reload();
	await expect(page.getByRole('heading',{name:'Hello, Temporary'})).toBeVisible();
	const otherContext=await browser.newContext();
	try{
		const otherDevice=await otherContext.newPage();
		await otherDevice.goto('/login');
		await waitForStartup(otherDevice);
		await otherDevice.getByLabel('Email or administrator username').fill(email);
		await otherDevice.getByLabel('Password',{exact:true}).fill(password);
		await otherDevice.getByRole('checkbox',{name:/Replace the active Aurevia session/}).check();
		await otherDevice.getByRole('button',{name:'Sign in'}).click();
		await otherDevice.waitForURL(/dashboard/);
		const response=await page.request.get('/api/dashboard');
		expect(response.status()).toBe(401);
	}finally{await otherContext.close();}
});

for(const viewport of viewports){
	test(`authenticated routes render without horizontal overflow at ${viewport.width}x${viewport.height}`,async({page})=>{
		await page.setViewportSize(viewport);
		await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
		for(const route of authenticatedRoutes){
			const response=await page.goto(route);
			expect(response?.status(),route).toBe(200);
			await expect(page.locator('h1').first(),route).toBeVisible();
			await expectNoHorizontalOverflow(page);
		}
	});
}

test('notifications bell, unread state, mark one/all, and history persist',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.setViewportSize({width:390,height:844});
	await page.goto('/');
	const bell=page.getByRole('button',{name:/Notifications/});
	await expect(bell).toContainText(/\d/);
	await bell.click();
	const dialog=page.getByRole('dialog',{name:'Notifications'});
	await expect(dialog).toBeVisible();
	const closeButton=dialog.getByRole('button',{name:'Close notifications'});
	await expect.poll(()=>closeButton.evaluate(element=>{
		const bounds=element.getBoundingClientRect();
		const target=document.elementFromPoint(bounds.left+bounds.width/2,bounds.top+bounds.height/2);
		return target===element||element.contains(target);
	})).toBe(true);
	const first=page.locator('.notification-row').filter({hasText:'E2E unread notification one'});
	await expect(first).toBeVisible();
	await first.click();
	await page.getByRole('button',{name:'Mark all notifications as read'}).click();
	await expect(page.locator('.notification-count')).toHaveCount(0);
	await page.goto('/notifications');
	await expect(page.getByRole('heading',{name:'Notifications'})).toBeVisible();
	await expect(page.getByText('All caught up')).toBeVisible();
	await page.reload();
	await expect(page.getByText('All caught up')).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('account-mode changes refresh and isolate wallet, trade, history, and support state',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	const mode=page.getByLabel('Account mode');
	await page.goto('/wallet');
	await expect(page.getByText('DEMO ACCOUNT',{exact:true}).last()).toBeVisible();
	let releaseModeUpdate!:()=>void;
	const modeUpdateGate=new Promise<void>(resolve=>{releaseModeUpdate=resolve});
	await page.route('**/api/account/mode',async route=>{await modeUpdateGate;await route.continue()});
	await selectAccountMode(page,'REAL',{waitForCompletion:false});
	await expect(mode).toBeDisabled();
	releaseModeUpdate();
	await page.unroute('**/api/account/mode');
	await expect(mode).toHaveValue('REAL');
	await expect(page.getByText('REAL ACCOUNT',{exact:true}).last()).toBeVisible();
	await expect(page.locator('.wallet-balance-value')).toHaveText('0.00 USD');
	const instrumentsResponse=await page.request.get('/api/market');
	const instruments=await instrumentsResponse.json();
	const realOrderResponse=await page.request.post('/api/orders',{data:{instrumentId:instruments[0].id,side:'BUY',type:'MARKET',quantity:1}});
	expect(realOrderResponse.status()).toBe(400);
	expect((await realOrderResponse.json()).error).toContain('REAL_EXECUTION_UNAVAILABLE');
	await page.goto('/wallet/transactions');
	await expect(page.locator('.account-heading .status-pill')).toContainText('REAL ACCOUNT');
	await expect(page.getByText('No transactions yet')).toBeVisible();
	await selectAccountMode(page,'DEMO');
	await expect(page.locator('.account-heading .status-pill')).toContainText('DEMO ACCOUNT');
	await page.goto('/trade');
	await selectAccountMode(page,'REAL');
	await expect(page.getByText('REAL execution status',{exact:true})).toBeVisible();
	await expect(page.getByRole('button',{name:'Place BUY order'})).toHaveCount(0);
	await selectAccountMode(page,'DEMO');
	await expect(page.getByRole('button',{name:'Place BUY order'})).toBeEnabled();
	await page.goto('/support');
	await page.getByRole('button',{name:'Contact Admin'}).click();
	const subject=`Mode-scoped support ${randomUUID().slice(0,8)}`;
	await page.getByLabel('Subject').fill(subject);
	await page.getByLabel('Message').fill('Temporary DEMO support isolation test.');
	await page.getByRole('button',{name:'Create support ticket'}).click();
	await expect(page.getByRole('button').filter({hasText:subject})).toBeVisible();
	await selectAccountMode(page,'REAL');
	await expect(page.getByRole('button').filter({hasText:subject})).toHaveCount(0);
	await selectAccountMode(page,'DEMO');
	await expect(page.getByRole('button').filter({hasText:subject})).toBeVisible();
});

test('REAL provider status is admin-only, configured deposit credits work, and withdrawals remain provider-gated',async({browser,page})=>{
	await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
	expect((await page.request.get('/api/admin/providers/status')).status()).toBe(403);
	expect((await page.request.post('/api/webhooks/broker/unconfigured',{data:{eventId:'synthetic-test-event'}})).status()).toBe(503);
	await selectAccountMode(page,'REAL');
	await expect.poll(async()=>Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(0);
	const instruments=await page.request.get('/api/market').then(response=>response.json());
	const blockedOrder=await page.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{instrumentId:instruments[0].id,side:'BUY',type:'MARKET',quantity:1}});
	expect(blockedOrder.status()).toBe(400);
	expect((await blockedOrder.json()).error).toContain('REAL_EXECUTION_UNAVAILABLE');
	const secondBlockedOrder=await page.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{instrumentId:instruments[0].id,side:'BUY',type:'MARKET',quantity:1}});
	expect(secondBlockedOrder.status()).toBe(400);
	expect(await page.request.get('/api/orders').then(response=>response.json())).toHaveLength(0);

	const adminContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const statusResponse=await adminPage.request.get('/api/admin/providers/status');
		expect(statusResponse.ok()).toBe(true);
		const status=await statusResponse.json();
		expect(status.realExecution).toMatchObject({status:'DISABLED',enabled:false,executionPathEnabled:false,adapterRegistered:false});
		expect(status.funding).toMatchObject({status:'NOT_CONFIGURED',connected:false,workflowEnabled:false,configuredSimulatedRealCreditsEnabled:true,realMoneyMovementEnabled:false});
		expect(status.investments).toMatchObject({status:'NOT_CONFIGURED',realLifecycleActionsEnabled:false});
		expect(status.realExecution.configuredVariables).toHaveProperty('BROKER_API_KEY');
		expect(JSON.stringify(status)).not.toContain('://');

		const depositApproval=await adminPage.request.patch('/api/admin/funding',{data:{id:fixture('REAL_DEPOSIT_ID'),decision:'APPROVED'}});
		expect(depositApproval.status()).toBe(200);
		expect(Number((await depositApproval.json()).creditedAmount)).toBe(125);
		const withdrawalApproval=await adminPage.request.patch('/api/admin/funding',{data:{id:fixture('REAL_WITHDRAWAL_ID'),decision:'APPROVED'}});
		expect(withdrawalApproval.status()).toBe(409);
		expect((await withdrawalApproval.json()).error).toBe('REAL_WITHDRAWAL_PROVIDER_UNAVAILABLE');
		const settlement=await adminPage.request.post('/api/admin/funding/settle',{data:{id:fixture('REAL_WITHDRAWAL_ID'),settlementReference:'TEST-REFERENCE'}});
		expect(settlement.status()).toBe(503);
		expect((await settlement.json()).error).toBe('REAL_WITHDRAWAL_PROVIDER_UNAVAILABLE');
		const fundingHistory=await adminPage.request.get('/api/admin/funding?history=true').then(response=>response.json());
		expect(fundingHistory.find((row:{id:string})=>row.id===fixture('REAL_DEPOSIT_ID'))).toMatchObject({status:'APPROVED',accountMode:'REAL',creditedAmount:'125'});
		expect(fundingHistory.find((row:{id:string})=>row.id===fixture('REAL_WITHDRAWAL_ID'))).toMatchObject({status:'PENDING_REVIEW',settlementReference:null,settledAt:null});
	}finally{await adminContext.close();}

	await expect.poll(async()=>Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(125);
	await selectAccountMode(page,'DEMO');
	await expect.poll(async()=>Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(5000);
});

test('Account Funding loads its wallet independently and clearly blocks unconfigured REAL funding',async({page})=>{
	await page.setViewportSize({width:390,height:844});
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await selectAccountMode(page,'DEMO');
	await page.goto('/wallet');
	await expect(page.getByRole('heading',{name:/wallet|funding/i}).first()).toBeVisible();
	await expect(page.locator('.wallet-balance-value')).toHaveText('5,000.00 USD');
	await expect(page.getByLabel('Payment method')).toBeEnabled();
	const fundingTypeButtons=page.locator('.wallet-type-switch button');
	await fundingTypeButtons.nth(1).click();
	await expect(fundingTypeButtons.nth(1)).toHaveAttribute('aria-pressed','true');
	await fundingTypeButtons.nth(0).click();
	await page.getByRole('button',{name:'Hide balances'}).click();
	await expect(page.getByRole('button',{name:'Show balances'})).toBeVisible();
	await page.getByRole('button',{name:'Show balances'}).click();
	await page.route('**/api/payment-methods',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Payment methods are temporarily unavailable.'})}));
	await page.getByRole('button',{name:'Refresh wallet history'}).click();
	await expect(page.getByText('Loading wallet data…')).toHaveCount(0);
	await expect(page.locator('.wallet-balance-value')).toHaveText('5,000.00 USD');
	await expect(page.getByRole('status').filter({hasText:'Payment methods are temporarily unavailable.'})).toBeVisible();
	await page.unroute('**/api/payment-methods');
	await page.route('**/api/wallet',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Wallet data is temporarily unavailable.'})}));
	await page.getByRole('button',{name:'Refresh wallet history'}).click();
	await expect(page.getByText('Loading wallet data…')).toHaveCount(0);
	await expect(page.locator('.wallet-balance-value')).toHaveText('Unavailable');
	await expect(page.getByRole('alert').filter({hasText:'Wallet data is temporarily unavailable.'})).toBeVisible();
	await expect(page.getByRole('button',{name:/Review deposit request/i})).toBeDisabled();
	await page.unroute('**/api/wallet');
	await page.getByRole('button',{name:'Refresh wallet history'}).click();
	await expect(page.locator('.wallet-balance-value')).toHaveText('5,000.00 USD');
	await selectAccountMode(page,'REAL');
	await page.goto('/wallet');
	const methods=await page.request.get('/api/payment-methods').then(response=>response.json());
	expect(methods).toMatchObject({methods:[],fundingStatus:'NOT_CONFIGURED',realFundingAvailable:false});
	await expect(page.getByRole('status').filter({hasText:'No self-service REAL deposit method is configured'}).first()).toBeVisible();
	await expect(page.getByLabel('Payment method')).toHaveValue('');
	await expect(page.getByRole('button',{name:/Review deposit request/i})).toBeDisabled();
	await expect(page.getByRole('alert').filter({hasText:'Wallet data is temporarily unavailable'})).toHaveCount(0);
	for(const width of [320,375,390,430,1440]){
		await page.setViewportSize({width,height:900});
		await expectNoHorizontalOverflow(page);
	}
	await selectAccountMode(page,'DEMO');
});

test('DEMO trading supports cash-backed buy and owned-unit sell execution',async({browser,page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	const symbol=fixture('INSTRUMENT_B');
	await page.goto('/markets');
	await expect(page.getByRole('heading',{name:'Mercados',exact:true})).toBeVisible();
	const marketPageUrl=page.url();
	const tradePage=await page.context().newPage();
	try{
		await tradePage.goto('/trade');
		const instrument=tradePage.getByRole('button',{name:new RegExp(symbol.replace('/','\\/'))});
		await expect(instrument).toBeVisible();
		await instrument.click();
		await expect(tradePage.locator('.recharts-surface').first()).toBeVisible();
		await expect(tradePage.getByText('Internal simulated market')).toBeVisible();
		const orderResponsePromise=tradePage.waitForResponse(response=>response.url().endsWith('/api/orders')&&response.request().method()==='POST');
		await tradePage.getByRole('button',{name:'Place BUY order'}).click();
		await expect(tradePage.getByRole('status')).toContainText('Order accepted');
		const orderResponse=await orderResponsePromise;
		expect(orderResponse.ok()).toBeTruthy();
		const order=await orderResponse.json();
		expect(order.status).toBe('FILLED');
		expect(order.executions).toHaveLength(1);
		await tradePage.getByRole('button',{name:'Sell',exact:true}).click();
		const sellResponsePromise=tradePage.waitForResponse(response=>response.url().endsWith('/api/orders')&&response.request().method()==='POST');
		await tradePage.getByRole('button',{name:'Place SELL order'}).click();
		await expect(tradePage.getByRole('status')).toContainText('Order accepted');
		const sellResponse=await sellResponsePromise;
		expect(sellResponse.ok()).toBeTruthy();
		expect((await sellResponse.json()).status).toBe('FILLED');
		const openPositions=await tradePage.request.get('/api/positions');
		expect(await openPositions.json()).toHaveLength(0);
		const freshMarkets=await tradePage.request.get('/api/market').then(response=>response.json());
		const freshInstrument=freshMarkets.find((item:{symbol:string})=>item.symbol===symbol);
		const oversell=await tradePage.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{instrumentId:freshInstrument.id,side:'SELL',type:'MARKET',quantity:1,expectedPrice:Number(freshInstrument.price),observedAt:freshInstrument.lastUpdatedAt}});
		expect(oversell.status()).toBe(400);
		expect((await oversell.json()).error).toContain('INSUFFICIENT_POSITION');
		const privateActivity=await tradePage.request.get('/api/market/activity').then(response=>response.json());
		expect(privateActivity.source).toBe('simulated execution records');
		expect(privateActivity.activity.filter((event:{instrument:string;accountMode:string})=>event.instrument===symbol&&event.accountMode==='DEMO')).toHaveLength(2);
		const unrelatedContext=await browser.newContext();
		try{
			const unrelatedPage=await unrelatedContext.newPage();
			await loginAs(unrelatedPage,fixture('LEGACY_USER_EMAIL'),fixture('LEGACY_USER_PASSWORD'));
			const unrelatedActivity=await unrelatedPage.request.get('/api/market/activity').then(response=>response.json());
			expect(unrelatedActivity.activity).toHaveLength(0);
		}finally{await unrelatedContext.close();}
		expect(page.url()).toBe(marketPageUrl);
		await selectAccountMode(page,'REAL');
		await expect.poll(async()=>{
			const response=await tradePage.request.get('/api/market/activity');
			return (await response.json()).activity;
		}).toHaveLength(0);
		await selectAccountMode(page,'DEMO');
		await expectNoHorizontalOverflow(page);
	}finally{if(!tradePage.isClosed())await tradePage.close();}
});

test('closing a DEMO position records a sell execution, reconciles portfolio, and notifies',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	const initialWallet=await page.request.get('/api/wallet').then(response=>response.json());
	expect(Number(initialWallet.balance)).toBeGreaterThan(0);
	const instruments=await page.request.get('/api/market').then(response=>response.json());
	const instrument=instruments.find((item:{symbol:string})=>item.symbol===fixture('INSTRUMENT_A'));
	expect(instrument).toBeTruthy();
	const buy=await page.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{instrumentId:instrument.id,side:'BUY',type:'MARKET',quantity:1,expectedPrice:Number(instrument.price),observedAt:instrument.lastUpdatedAt}});
	expect(buy.ok()).toBeTruthy();
	expect((await buy.json()).status).toBe('FILLED');
	const afterBuyWallet=await page.request.get('/api/wallet').then(response=>response.json());
	expect(Number(afterBuyWallet.balance)).toBeLessThan(5000);
	const positions=await page.request.get('/api/positions').then(response=>response.json());
	expect(positions).toHaveLength(1);
	const openPortfolio=await page.request.get('/api/portfolio').then(response=>response.json());
	expect(Number(openPortfolio.totalValue)).toBeCloseTo(Number(openPortfolio.cashBalance)+Number(openPortfolio.positionValue),2);

	const close=await page.request.post('/api/positions',{data:{positionId:positions[0].id}});
	expect(close.ok()).toBeTruthy();
	expect((await page.request.get('/api/positions').then(response=>response.json()))).toHaveLength(0);
	const orders=await page.request.get('/api/orders').then(response=>response.json());
	const closeOrder=orders.find((order:{side:string;instrumentId:string;status:string})=>order.side==='SELL'&&order.instrumentId===instrument.id&&order.status==='FILLED');
	expect(closeOrder).toBeTruthy();
	expect(closeOrder.executions).toHaveLength(1);
	const closedPortfolio=await page.request.get('/api/portfolio').then(response=>response.json());
	expect(Number(closedPortfolio.positionValue)).toBe(0);
	expect(closedPortfolio.realizedPnl).not.toBeNull();
	const notificationResponse=await page.request.get('/api/notifications?limit=100').then(response=>response.json());
	expect(notificationResponse.notifications.some((item:{title:string;relatedId:string|null})=>item.relatedId===closeOrder.id&&item.title==='Demo position closed')).toBe(true);
});

test('investment requests remain mode-isolated through admin review without fake REAL settlement',async({browser,page})=>{
	const adminContext=await browser.newContext();
	const adminPage=await adminContext.newPage();
	try{
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const opportunityResponse=await adminPage.request.post('/api/admin/investments',{data:{title:'E2E simulated opportunity',category:'Test allocation',description:'Disposable investment terms for isolated Playwright coverage.',assetSymbol:null,minimumAmount:100,maximumAmount:10000,targetReturnPercent:8,durationDays:30,startsAt:null,maturesAt:null,riskLevel:'MODERATE',status:'AVAILABLE',demoEligible:true,realEligible:true,requiresApproval:true,targetPrice:null,stopPrice:null}});
		expect(opportunityResponse.status()).toBe(201);
		const opportunity=await opportunityResponse.json();

		await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
		await selectAccountMode(page,'DEMO');
		const initialDemoWallet=await page.request.get('/api/wallet').then(response=>response.json());
		expect(Number(initialDemoWallet.balance)).toBe(5000);
		await page.goto('/investments');
		await expect(page.getByRole('heading',{name:'Available opportunities'})).toBeVisible();
		await page.getByLabel('Amount (USD)').fill('1000');
		await page.getByRole('button',{name:'Request investment'}).click();
		await expect(page.getByRole('status')).toContainText('DEMO request recorded');
		let userInvestments=await page.request.get('/api/investments').then(response=>response.json());
		const demoRequest=userInvestments.requests.find((item:{opportunityId:string;accountMode:string})=>item.opportunityId===opportunity.id&&item.accountMode==='DEMO');
		expect(demoRequest.status).toBe('PENDING_APPROVAL');
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(4000);

		const unrelatedContext=await browser.newContext();
		try{
			const unrelatedPage=await unrelatedContext.newPage();
			await loginAs(unrelatedPage,fixture('LEGACY_USER_EMAIL'),fixture('LEGACY_USER_PASSWORD'));
			const isolated=await unrelatedPage.request.get('/api/investments').then(response=>response.json());
			expect(isolated.requests).toHaveLength(0);
			expect((await unrelatedPage.request.get('/api/admin/investments')).status()).toBe(403);
		}finally{await unrelatedContext.close();}

		async function review(requestId:string,action:string,extra:Record<string,unknown>={}){
			const response=await adminPage.request.patch('/api/admin/investments',{data:{requestId,action,...extra}});
			const result=await response.json();
			expect(response.ok(),`${action}: ${result.error||response.status()}`).toBeTruthy();
			return result;
		}
		await review(demoRequest.id,'approve');
		await review(demoRequest.id,'activate');
		await review(demoRequest.id,'complete');
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(4000);
		await review(demoRequest.id,'settle',{simulatedPayout:1100});
		userInvestments=await page.request.get('/api/investments').then(response=>response.json());
		expect(userInvestments.requests.find((item:{id:string})=>item.id===demoRequest.id).status).toBe('SETTLED');
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(5100);

		await selectAccountMode(page,'REAL');
			await expect.poll(async()=>Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(125);
			const unavailableMethods=await page.request.get('/api/payment-methods').then(response=>response.json());
			expect(unavailableMethods).toMatchObject({methods:[],fundingStatus:'NOT_CONFIGURED',realFundingAvailable:false});
			const existingFunding=await page.request.get('/api/wallet').then(response=>response.json());
			const blockedFunding=await page.request.post('/api/wallet',{headers:{'Idempotency-Key':randomUUID()},data:{type:'DEPOSIT',paymentMethodId:'not-configured',amount:10,currency:'USD',transactionReference:`E2E-${randomUUID()}`}});
			expect(blockedFunding.status()).toBe(400);
			expect((await blockedFunding.json()).error).toBe('payment method unavailable');
			expect(await page.request.get('/api/wallet').then(async response=>(await response.json()).transactions.length)).toBe(existingFunding.transactions.length);
			await page.goto('/wallet');
			await expect(page.getByRole('status').filter({hasText:'No self-service REAL deposit method is configured'}).first()).toBeVisible();
			await expect(page.getByLabel('Payment method')).toHaveValue('');
		await page.goto('/investments');
		await expect(page.getByText(/administrator review of an identity profile, not external KYC\/AML clearance/i)).toBeVisible();
		const realRequestResponse=await page.request.post('/api/investments',{headers:{'Idempotency-Key':randomUUID()},data:{opportunityId:opportunity.id,amount:500}});
		expect(realRequestResponse.status()).toBe(201);
		const realRequest=await realRequestResponse.json();
		expect(realRequest.status).toBe('PENDING_APPROVAL');
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(125);
		await review(realRequest.id,'approve');
		const unreferencedActivation=await adminPage.request.patch('/api/admin/investments',{data:{requestId:realRequest.id,action:'activate'}});
		expect(unreferencedActivation.status()).toBe(409);
		const fabricatedActivation=await adminPage.request.patch('/api/admin/investments',{data:{requestId:realRequest.id,action:'activate',executionReference:'UNVERIFIED-REFERENCE'}});
		expect(fabricatedActivation.status()).toBe(409);
		expect((await fabricatedActivation.json()).error).toBe('REAL_INVESTMENT_PROVIDER_UNAVAILABLE');
		const fabricatedSettlement=await adminPage.request.patch('/api/admin/investments',{data:{requestId:realRequest.id,action:'settle',settlementReference:'UNVERIFIED-SETTLEMENT',simulatedPayout:600}});
		expect(fabricatedSettlement.status()).toBe(409);
		expect((await fabricatedSettlement.json()).error).toBe('REAL_INVESTMENT_PROVIDER_UNAVAILABLE');
		await review(realRequest.id,'cancel');
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(125);

		await selectAccountMode(page,'DEMO');
			await expect.poll(async()=>Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(5100);
			await logout(page);
		await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
		const persistedDemoWallet=await page.request.get('/api/wallet').then(response=>response.json());
		expect(Number(persistedDemoWallet.balance)).toBe(5100);
		await page.goto('/portfolio');
		await page.getByRole('button',{name:'Reset DEMO'}).click();
		await page.getByLabel('Type RESET DEMO ACCOUNT to confirm').fill('RESET DEMO ACCOUNT');
		await page.getByRole('button',{name:'Confirm DEMO reset'}).click();
		await expect(page.getByRole('status')).toContainText('DEMO portfolio reset to $5,000.00');
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(5000);
		await selectAccountMode(page,'REAL');
			await expect.poll(async()=>Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(125);
		await expectNoHorizontalOverflow(page);
	}finally{await adminContext.close();}
});

test('Nova escalation reaches admin and admin response appears with notification',async({page})=>{
	const subject=`E2E support ${randomUUID().slice(0,8)}`;
	const reply='Temporary Playwright admin response.';
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/support');
	await expect(page.getByRole('heading',{name:'Nova AI',exact:true})).toBeVisible();
	const wallet=await page.request.get('/api/wallet').then(response=>response.json());
	const novaResponse=await page.request.post('/api/support/nova',{data:{question:'What is my wallet balance?',conversationId:randomUUID()}});
	expect(novaResponse.status()).toBe(200);
	expect((await novaResponse.json()).answer).toContain(String(wallet.balance));
	const portfolioReply=await page.request.post('/api/support/nova',{data:{question:'What are my positions and order history?',conversationId:randomUUID(),userId:'another-user-id'}});
	expect(portfolioReply.status()).toBe(200);
	expect((await portfolioReply.json()).answer).toContain('DEMO account');
	expect((await portfolioReply.json()).answer).toContain('order history contains');
	const watchlistReply=await page.request.post('/api/support/nova',{data:{question:'What is my watchlist?',conversationId:randomUUID()}});
	expect((await watchlistReply.json()).answer).toContain('cannot read a saved watchlist from the server');
	const notificationReply=await page.request.post('/api/support/nova',{data:{question:'How many unread notifications do I have?',conversationId:randomUUID()}});
	expect((await notificationReply.json()).answer).toMatch(/\d+ unread notification/);
	const paymentReply=await page.request.post('/api/support/nova',{data:{question:'How do I make a deposit?',conversationId:randomUUID()}});
	expect((await paymentReply.json()).answer).toContain('DEMO');
	expect((await paymentReply.json()).answer).toContain('do not send real funds');
	const supportContact=await page.request.get('/api/support/contact').then(response=>response.json());
	if(supportContact.email)await expect(page.getByRole('link',{name:new RegExp(supportContact.email.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))})).toBeVisible();
	else await expect(page.getByText('Direct email is not configured. Authenticated support tickets remain available.')).toBeVisible();
	await page.getByRole('button',{name:'Contact Admin'}).click();
	await page.getByLabel('Category').selectOption('FUNDING');
	await page.getByLabel('Subject').fill(subject);
	await page.getByLabel('Message').fill('Please review this disposable browser test ticket.');
	await page.getByRole('button',{name:'Create support ticket'}).click();
	await expect(page.getByRole('status')).toContainText(/created\./i);
	await logout(page);
	await expect(page).toHaveURL(/\/login/);
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	await page.goto('/admin/support');
	await page.getByRole('button',{name:new RegExp(subject)}).click();
	const priority=page.locator('.admin-support-ticket-controls select').nth(1);
	await priority.selectOption('HIGH');
	await expect(priority).toHaveValue('HIGH');
	await page.getByLabel('Admin response').fill(reply);
	await page.getByRole('button',{name:'Send response'}).click();
	await expect(page.getByRole('status')).toContainText('Response sent to the user');
	await logout(page);
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/notifications');
	const replyNotification=page.locator('.notification-history-item').filter({hasText:subject});
	await expect(replyNotification.getByText('Admin replied to your support ticket',{exact:true})).toBeVisible();
	await page.goto('/support');
	const ticket=page.getByRole('button').filter({hasText:subject});
	await ticket.click();
	await expect(page.getByText(reply)).toBeVisible();
	const conversationId=await page.request.get('/api/support').then(async response=>{
		expect(response.ok()).toBe(true);
		const tickets=await response.json();
		return tickets.find((item:{subject:string})=>item.subject===subject).id as string;
	});
	await logout(page);
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	const closed=await page.request.patch('/api/admin/support',{data:{action:'status',conversationId,status:'CLOSED'}});
	expect(closed.ok()).toBe(true);
	await logout(page);
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/support');
	await page.getByRole('button').filter({hasText:subject}).click();
	await expect(page.getByText(/CLOSED/)).toBeVisible();
	await expect(page.getByRole('textbox',{name:'Reply to support ticket'})).toHaveCount(0);
	const replyToClosed=await page.request.post('/api/support',{data:{action:'reply',conversationId,message:'Reply to a closed ticket.'}});
	expect(replyToClosed.status()).toBe(409);
});

test('tier requests require an administrator decision and never enable real execution',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/tier');
	await expect(page.getByRole('heading',{name:'Tier and verification'})).toBeVisible();
	const state=await page.request.get('/api/tier-requests').then(response=>response.json());
	expect(state.currentTier).toBe(1);
	await page.getByRole('button',{name:'Request Tier 2 review'}).click();
	await expect(page.getByRole('status')).toContainText('waiting for administrator review');
	const request=await page.request.get('/api/tier-requests').then(response=>response.json());
	const requestId=request.requests[0].id as string;
	expect(request.requests[0].status).toBe('PENDING_REVIEW');
	const denied=await page.request.patch('/api/admin/tier-requests',{data:{id:requestId,status:'APPROVED',reason:'Should be denied for a user.'}});
	expect(denied.status()).toBe(403);
	await logout(page);
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	await page.goto('/admin/tiers');
	await expect(page.getByRole('heading',{name:'Tier review queue'})).toBeVisible();
	await page.getByRole('button').filter({hasText:'Temporary E2E User'}).click();
	await page.getByLabel('Required review reason').fill('Isolated browser test approval.');
	await page.getByRole('button',{name:'Approve Tier 2'}).click();
	await expect(page.getByRole('status')).toContainText('Tier request approved');
	await logout(page);
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	const updated=await page.request.get('/api/tier-requests').then(response=>response.json());
	expect(updated.currentTier).toBe(2);
	await page.goto('/tier');
	await expect(page.getByText(/REAL execution remains separately controlled/i)).toBeVisible();
});

test('administrator email sign-in persists through refresh and logout removes admin access',async({page})=>{
	await page.goto('/admin/login');
	await waitForStartup(page);
	await page.getByLabel('Admin username').fill(fixture('ADMIN_EMAIL'));
	await page.getByLabel('Admin password',{exact:true}).fill(fixture('ADMIN_PASSWORD'));
	await page.getByRole('checkbox',{name:/Replace another active Aurevia session/}).check();
	await page.getByRole('button',{name:'Enter control center'}).click();
	await page.waitForURL(/\/admin$/);
	await expect(page.getByRole('heading',{name:'Aurevia administration'})).toBeVisible();
	await page.getByRole('banner').getByRole('button',{name:'Open navigation'}).click();
	await expect(page.getByRole('navigation',{name:'Primary navigation'}).getByRole('link',{name:'Admin',exact:true})).toBeVisible();
	await page.reload();
	await expect(page.getByRole('heading',{name:'Aurevia administration'})).toBeVisible();
	await logout(page);
	await expect(page).toHaveURL(/\/login/);
	await page.goto('/admin');
	await expect(page).toHaveURL(/\/login/);
});

test('admin funding updates separate DEMO and simulated/configured REAL balances',async({page})=>{
	await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
	await selectAccountMode(page,'DEMO');
	const userId=await page.request.get('/api/auth/session').then(async response=>(await response.json()).user.id as string);
	const before=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	await selectAccountMode(page,'REAL');
	const beforeRealBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	await selectAccountMode(page,'DEMO');
	await logout(page);
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	const credited=await page.request.patch('/api/admin/users',{data:{userId,manualBalance:{accountMode:'DEMO',currency:'USD',amount:25.5,type:'CREDIT'}}});
	expect(credited.status()).toBe(200);
	const creditKey=randomUUID();
	const realCredit=await page.request.patch('/api/admin/users',{data:{userId,manualBalance:{accountMode:'REAL',currency:'USD',amount:25.5,type:'CREDIT',idempotencyKey:creditKey}}});
	expect(realCredit.status()).toBe(200);
	const duplicateRealCredit=await page.request.patch('/api/admin/users',{data:{userId,manualBalance:{accountMode:'REAL',currency:'USD',amount:25.5,type:'CREDIT',idempotencyKey:creditKey}}});
	expect(duplicateRealCredit.status()).toBe(200);
	await page.goto('/admin');
	const manualFunding=page.locator('section.card').filter({has:page.getByRole('heading',{name:'Manual account funding'})}).first();
	await expect(manualFunding.locator('select').nth(0).locator(`option[value="${userId}"]`)).toHaveCount(1);
	await manualFunding.locator('select').nth(0).selectOption(userId);
	await manualFunding.locator('select').nth(1).selectOption('REAL');
	await manualFunding.locator('input[type="number"]').fill('2500.00');
	await manualFunding.getByRole('button',{name:'Approve and credit simulated REAL deposit $2,500.00'}).click();
	await expect(page.getByRole('status').filter({hasText:'Simulated/configured REAL deposit of 2,500.00 USD credited'})).toBeVisible();
	await logout(page);
	await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
	await selectAccountMode(page,'REAL');
	const realWallet=await page.request.get('/api/wallet').then(response=>response.json());
	const realBalance=Number(realWallet.balance);
	expect(realBalance).toBeCloseTo(beforeRealBalance+2525.5,2);
	const configuredDeposits=realWallet.transactions.filter((item:{method:string})=>item.method==='Admin configured simulated REAL deposit');
	expect(configuredDeposits).toHaveLength(2);
	expect(configuredDeposits.every((item:{type:string;status:string;accountMode:string;currency:string})=>item.type==='DEPOSIT'&&item.status==='APPROVED'&&item.accountMode==='REAL'&&item.currency==='USD')).toBe(true);
	expect(configuredDeposits.map((item:{creditedAmount:string})=>Number(item.creditedAmount)).sort((left:number,right:number)=>left-right)).toEqual([25.5,2500]);
	await page.goto('/wallet');
	const configuredReceipt=page.locator('details').filter({hasText:'SIMULATED / CONFIGURED REAL DEPOSIT'}).first();
	await expect(configuredReceipt).toBeVisible();
	await configuredReceipt.locator('summary').click();
	await expect(configuredReceipt.getByText('SIMULATED / CONFIGURED REAL DEPOSIT',{exact:false})).toHaveCount(1);
	await selectAccountMode(page,'DEMO');
	const after=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	expect(after).toBeCloseTo(before+25.5,2);
});

test('a normal customer cannot access the administrator dashboard',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/admin');
	await expect(page).toHaveURL(/\/login/);
});

test('Nova activity is redacted and visible only to administrators',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await selectAccountMode(page,'DEMO');
	const userId=await page.request.get('/api/auth/session').then(async response=>(await response.json()).user.id as string);
	const question='What is my balance? e2e-private-question-marker';
	const novaResponse=await page.request.post('/api/support/nova',{data:{question}});
	expect(novaResponse.status()).toBe(200);
	const calculation=await page.request.post('/api/support/nova',{data:{question:'calculate position size: risk $100, entry $50, stop $45, target $60, long'}});
	expect(calculation.status()).toBe(200);
	expect(await calculation.json()).toMatchObject({answer:expect.stringContaining('20 units')});
	const forbidden=await page.request.get('/api/admin/nova-activity');
	expect(forbidden.status()).toBe(403);

	const symbol=fixture('INSTRUMENT_A');
	const beforeOrders=await page.request.get('/api/orders').then(response=>response.json() as Promise<Array<{id:string}>>);
	await page.goto('/support');
	await page.getByLabel('Ask Nova AI').fill(`prepare demo order: buy 2 ${symbol}`);
	await page.getByRole('button',{name:'Send question'}).click();
	const confirmOrder=page.getByRole('button',{name:'Confirm DEMO order'});
	await expect(confirmOrder).toBeVisible();
	const previewOrders=await page.request.get('/api/orders').then(response=>response.json() as Promise<Array<{id:string}>>);
	expect(previewOrders.map(order=>order.id)).toEqual(beforeOrders.map(order=>order.id));
	await confirmOrder.click();
	await expect(page.getByText(/Your explicitly confirmed DEMO order/)).toBeVisible();
	const ordersResponse=await page.request.get('/api/orders');
	const afterOrders=await ordersResponse.json() as Array<{id:string;instrument:{symbol:string};side:string;quantity:string;status:string}>;
	const confirmation=await page.locator('.nova-message').last().innerText();
	const orderId=confirmation.match(/Order reference: ([A-Za-z0-9]+)/)?.[1];
	const confirmed=afterOrders.find(order=>order.id===orderId);
	expect(confirmed).toBeTruthy();
	expect(confirmed).toMatchObject({instrument:{symbol},side:'BUY',status:'FILLED'});
	expect(Number(confirmed?.quantity)).toBe(2);
	const unsupportedOrder=await page.request.post('/api/support/nova',{data:{question:`prepare limit order: buy 1 ${symbol} at $10`}});
	expect(unsupportedOrder.status()).toBe(200);
	expect(await unsupportedOrder.json()).toMatchObject({answer:expect.stringContaining('market-order previews only')});
	await selectAccountMode(page,'REAL');
	const realDraft=await page.request.post('/api/support/nova',{data:{question:`prepare demo order: buy 1 ${symbol}`}});
	expect(realDraft.status()).toBe(200);
	expect(await realDraft.json()).toMatchObject({answer:expect.stringContaining('REAL trading is not available through Nova')});
	await selectAccountMode(page,'DEMO');

	await logout(page);
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	const report=await page.request.get('/api/admin/nova-activity');
	expect(report.status()).toBe(200);
	const events=await report.json();
	const event=events.find((item:{userId:string;eventTypes:string[]})=>item.userId===userId&&item.eventTypes.includes('WALLET_BALANCE_LOOKUP'));
	expect(event).toBeTruthy();
	expect(events.some((item:{userId:string;eventTypes:string[]})=>item.userId===userId&&item.eventTypes.includes('TRADE_PLAN_CALCULATED'))).toBe(true);
	expect(events.some((item:{userId:string;eventTypes:string[]})=>item.userId===userId&&item.eventTypes.includes('DEMO_ORDER_PREPARED'))).toBe(true);
	expect(JSON.stringify(events)).not.toContain('e2e-private-question-marker');
});

test('admin pages render for authenticated administrator at requested viewports',async({page})=>{
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	for(const viewport of viewports){
		await page.setViewportSize(viewport);
		for(const route of adminRoutes){
			const response=await page.goto(route);
			expect(response?.status(),route).toBe(200);
			await expect(page.locator('h1').first(),route).toBeVisible();
			await expectNoHorizontalOverflow(page);
		}
	}
});

test('DEMO order idempotency prevents duplicate fills and user history stays isolated',async({browser,page})=>{
	await loginAs(page,fixture('LEGACY_USER_EMAIL'),fixture('LEGACY_USER_PASSWORD'));
	const startingBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	expect(startingBalance).toBe(5000);
	const symbol=fixture('INSTRUMENT_A');
	const instruments=await page.request.get('/api/market').then(response=>response.json());
	const instrument=instruments.find((item:{symbol:string})=>item.symbol===symbol);
	expect(instrument).toBeTruthy();
	const key=randomUUID();
	const payload={instrumentId:instrument.id,side:'BUY',type:'MARKET',quantity:1,expectedPrice:Number(instrument.price),observedAt:instrument.lastUpdatedAt};
	const first=await page.request.post('/api/orders',{headers:{'Idempotency-Key':key},data:payload});
	const replay=await page.request.post('/api/orders',{headers:{'Idempotency-Key':key},data:payload});
	expect(first.status()).toBe(201);
	expect(replay.status()).toBe(201);
	const firstOrder=await first.json();
	const replayOrder=await replay.json();
	expect(replayOrder.id).toBe(firstOrder.id);
	expect(replayOrder.executions).toHaveLength(1);
	const afterBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	expect(afterBalance).toBeLessThan(startingBalance);
	expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(afterBalance);
	expect(await page.request.get('/api/orders').then(response=>response.json()).then((orders:Array<{id:string}>)=>orders.filter(order=>order.id===firstOrder.id))).toHaveLength(1);
	let position=(await page.request.get('/api/positions').then(response=>response.json()))[0];
	expect(Number(position.quantity)).toBe(1);

	const updatedMarket=await page.request.get('/api/market').then(response=>response.json());
	const updatedInstrument=updatedMarket.find((item:{symbol:string})=>item.symbol===symbol);
	const secondBuy=await page.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{instrumentId:updatedInstrument.id,side:'BUY',type:'MARKET',quantity:1,expectedPrice:Number(updatedInstrument.price),observedAt:updatedInstrument.lastUpdatedAt}});
	expect(secondBuy.status()).toBe(201);
	position=(await page.request.get('/api/positions').then(response=>response.json()))[0];
	expect(Number(position.quantity)).toBe(2);
	const openPortfolio=await page.request.get('/api/portfolio').then(response=>response.json());
	expect(Number(openPortfolio.totalValue)).toBeCloseTo(Number(openPortfolio.cashBalance)+Number(openPortfolio.positionValue),2);
	expect(Number(openPortfolio.unrealizedPnl)).toBeCloseTo(Number(position.unrealizedPnl),2);

	const sellMarket=await page.request.get('/api/market').then(response=>response.json());
	const sellInstrument=sellMarket.find((item:{symbol:string})=>item.symbol===symbol);
	const partialSell=await page.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{instrumentId:sellInstrument.id,side:'SELL',type:'MARKET',quantity:0.5,expectedPrice:Number(sellInstrument.price),observedAt:sellInstrument.lastUpdatedAt}});
	expect(partialSell.status()).toBe(201);
	position=(await page.request.get('/api/positions').then(response=>response.json()))[0];
	expect(Number(position.quantity)).toBe(1.5);
	expect(Number(position.realizedPnl)).not.toBe(0);
	const close=await page.request.post('/api/positions',{data:{positionId:position.id}});
	expect(close.ok()).toBeTruthy();
	expect(await page.request.get('/api/positions').then(response=>response.json())).toHaveLength(0);
	const closedPortfolio=await page.request.get('/api/portfolio').then(response=>response.json());
	expect(Number(closedPortfolio.positionValue)).toBe(0);
	expect(Number(closedPortfolio.realizedPnl)).not.toBe(0);

	const otherContext=await browser.newContext();
	try{
		const otherPage=await otherContext.newPage();
		await loginAs(otherPage,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
		const otherOrders=await otherPage.request.get('/api/orders').then(response=>response.json());
		expect(otherOrders.some((order:{id:string})=>order.id===firstOrder.id)).toBe(false);
	}finally{await otherContext.close();}
});

test('wallet deposit and withdrawal requests remain pending and idempotent without posting money',async({browser,page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await selectAccountMode(page,'DEMO');
	const startingBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	const methods=await page.request.get('/api/payment-methods').then(async response=>(await response.json()).methods);
	expect(methods.length).toBeGreaterThan(0);
	const method=methods[0];

	const depositKey=randomUUID();
	const depositPayload={type:'DEPOSIT',paymentMethodId:method.id,amount:100,currency:'USD'};
	const deposit=await page.request.post('/api/wallet',{headers:{'Idempotency-Key':depositKey},data:depositPayload});
	expect(deposit.status()).toBe(201);
	const depositRequest=await deposit.json();
	expect(depositRequest.status).toBe('PENDING_REVIEW');
	expect(depositRequest.accountMode).toBe('DEMO');
	const replay=await page.request.post('/api/wallet',{headers:{'Idempotency-Key':depositKey},data:depositPayload});
	expect(replay.status()).toBe(200);
	expect((await replay.json()).id).toBe(depositRequest.id);
	expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(startingBalance);

	const withdrawal=await page.request.post('/api/wallet',{headers:{'Idempotency-Key':randomUUID()},data:{type:'WITHDRAWAL',paymentMethodId:method.id,amount:10,currency:'USD'}});
	expect(withdrawal.status()).toBe(201);
	expect((await withdrawal.json()).status).toBe('PENDING_REVIEW');
	expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(startingBalance);

	const otherContext=await browser.newContext();
	try{
		const otherPage=await otherContext.newPage();
		await loginAs(otherPage,fixture('LEGACY_USER_EMAIL'),fixture('LEGACY_USER_PASSWORD'));
		const otherWallet=await otherPage.request.get('/api/wallet').then(response=>response.json());
		expect(otherWallet.transactions).toHaveLength(0);
	}finally{await otherContext.close();}
});

test('approved deposit receipts use the credited amount and reviewer audit',async({browser,page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await selectAccountMode(page,'DEMO');
	const startingBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	const methods=await page.request.get('/api/payment-methods').then(async response=>(await response.json()).methods);
	const deposit=await page.request.post('/api/wallet',{headers:{'Idempotency-Key':randomUUID()},data:{type:'DEPOSIT',paymentMethodId:methods[0].id,amount:100,currency:'USD',transactionReference:`E2E-${randomUUID()}`}});
	expect(deposit.status()).toBe(201);
	const request=await deposit.json();
	await logout(page);
	const adminContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const approval=await adminPage.request.patch('/api/admin/funding',{data:{id:request.id,decision:'APPROVED',creditedAmount:61.25,note:'Verified partial settlement'}});
		expect(approval.status()).toBe(200);
		expect(Number((await approval.json()).creditedAmount)).toBe(61.25);
	}finally{await adminContext.close();}
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await selectAccountMode(page,'DEMO');
	const wallet=await page.request.get('/api/wallet').then(response=>response.json());
	expect(Number(wallet.balance)).toBeCloseTo(startingBalance+61.25,2);
	const transaction=wallet.transactions.find((item:{id:string})=>item.id===request.id);
	expect(transaction).toMatchObject({status:'APPROVED',creditedAmount:'61.25',reviewedBy:{email:fixture('ADMIN_EMAIL')}});
	expect(transaction.reviewedAt).toBeTruthy();
	await page.goto('/wallet');
	const receiptDetails=page.locator('details').filter({hasText:request.id}).first();
	await receiptDetails.locator('summary').click();
	await expect(receiptDetails.getByText('61.25 USD',{exact:true})).toBeVisible();
	await expect(receiptDetails.getByText('Reviewed by',{exact:true})).toBeVisible();
	const downloadPromise=page.waitForEvent('download');
	await receiptDetails.getByRole('button',{name:'Download PDF'}).nth(1).click();
	expect((await downloadPromise).suggestedFilename()).toContain('approval');
});

test('matured DEMO investments automatically credit their configured target once',async({page})=>{
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	const opportunityResponse=await page.request.post('/api/admin/investments',{data:{title:'E2E automatic maturity',category:'Simulated Bitcoin',description:'Disposable target return investment for maturity processing coverage.',assetSymbol:'BTC',minimumAmount:10,maximumAmount:1000,targetReturnPercent:15,durationDays:1,startsAt:null,maturesAt:null,riskLevel:'MODERATE',status:'AVAILABLE',demoEligible:true,realEligible:false,requiresApproval:true,targetPrice:null,stopPrice:null}});
	expect(opportunityResponse.status()).toBe(201);
	const opportunity=await opportunityResponse.json();
	await logout(page);
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await selectAccountMode(page,'DEMO');
	const startingBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	const requestResponse=await page.request.post('/api/investments',{headers:{'Idempotency-Key':randomUUID()},data:{opportunityId:opportunity.id,amount:500}});
	expect(requestResponse.status()).toBe(201);
	const investment=await requestResponse.json();
	await logout(page);
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	for(const action of ['approve','activate']){
		const response=await page.request.patch('/api/admin/investments',{data:{requestId:investment.id,action}});
		expect(response.status()).toBe(200);
	}
	const testDatabase=new PrismaClient();
	try{await testDatabase.investmentRequest.update({where:{id:investment.id},data:{maturesAt:new Date(Date.now()-1000)}});}
	finally{await testDatabase.$disconnect();}
	await settleMaturedDemoInvestments();
	await settleMaturedDemoInvestments();
	const settled=await db.investmentRequest.findUniqueOrThrow({where:{id:investment.id}});
	expect(settled.status).toBe('SETTLED');
	expect(Number(settled.simulatedPayout)).toBe(575);
	expect(settled.settlementReference).toBe(`DEMO-AUTO-SETTLEMENT:${investment.id}`);
	await logout(page);
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await selectAccountMode(page,'DEMO');
	const endingBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	expect(endingBalance).toBeCloseTo(startingBalance+75,2);
	expect(await db.ledgerTransaction.count({where:{reference:`INVESTMENT:${investment.id}:PAYOUT`}})).toBe(1);
});

test('KYC document access is owner-scoped and private Storage fails closed without credentials',async({browser,page})=>{
	const documentId=fixture('KYC_DOCUMENT_ID');
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	expect((await page.request.get(`/api/kyc/documents/${documentId}`)).status()).toBe(404);
	expect((await page.request.get(`/api/admin/kyc/documents/${documentId}`)).status()).toBe(403);

	const unauthenticatedContext=await browser.newContext();
	try{
		const unauthenticatedPage=await unauthenticatedContext.newPage();
		expect((await unauthenticatedPage.request.get(`/api/kyc/documents/${documentId}`)).status()).toBe(401);
	}finally{await unauthenticatedContext.close();}

	const investorContext=await browser.newContext();
	try{
		const investorPage=await investorContext.newPage();
		await loginAs(investorPage,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
		const documents=await investorPage.request.get('/api/kyc/documents').then(response=>response.json());
		expect(documents.map((document:{id:string})=>document.id)).toContain(documentId);
		const ownerAccess=await investorPage.request.get(`/api/kyc/documents/${documentId}`);
		expect(ownerAccess.status()).toBe(503);
		expect((await ownerAccess.json()).error).toContain('Private file storage is not configured');

		const upload=await investorPage.request.post('/api/kyc/documents',{multipart:{
			kind:'IDENTITY_DOCUMENT',
			file:{name:'temporary-e2e.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\\nDisposable E2E document\\n%%EOF\\n')},
		}});
		expect(upload.status()).toBe(503);
		expect((await investorPage.request.get('/api/kyc/documents').then(response=>response.json()))).toHaveLength(documents.length);
	}finally{await investorContext.close();}

	const adminContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const adminAccess=await adminPage.request.get(`/api/admin/kyc/documents/${documentId}`);
		expect(adminAccess.status()).toBe(503);
		expect((await adminAccess.json()).error).toContain('Private file storage is not configured');
	}finally{await adminContext.close();}
});

test('profile settings persist for the owner and remain inaccessible to signed-out clients',async({browser,page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	const initialProfile=await page.request.get('/api/profile').then(response=>response.json());
	expect(initialProfile).toMatchObject({twoFactorEnabled:false,twoFactorAvailable:false});
	const enableTwoFactor=await page.request.patch('/api/profile',{data:{name:'Temporary E2E User',country:'Test',twoFactorEnabled:true}});
	expect(enableTwoFactor.status()).toBe(409);
	expect((await enableTwoFactor.json()).error).toContain('Two-factor authentication is unavailable');
	const updated=await page.request.patch('/api/profile',{data:{name:'Temporary Settings Update',country:'Test Country',address:'Isolated test address',twoFactorEnabled:false}});
	expect(updated.ok()).toBeTruthy();
	expect(await page.request.get('/api/profile').then(response=>response.json())).toMatchObject({name:'Temporary Settings Update',twoFactorEnabled:false,twoFactorAvailable:false});
	await page.goto('/settings');
	await page.getByRole('tab',{name:'Security'}).click();
	await expect(page.getByText('Unavailable — this account is not protected by two-factor authentication. Enrollment and login challenges are not configured.')).toBeVisible();
	await expect(page.getByText('Not enabled',{exact:true})).toBeVisible();
	const signedOutContext=await browser.newContext();
	try{
		const signedOutPage=await signedOutContext.newPage();
		expect((await signedOutPage.request.get('/api/profile')).status()).toBe(401);
	}finally{await signedOutContext.close();}
});
