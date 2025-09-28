// server_v1.3.0.js — core server v1.3.0 (see chat notes for full feature list)
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors({ origin:'*' }));
app.use(express.json());
app.use(rateLimit({ windowMs: 60*1000, max: 120 }));

const docsDir = path.join(process.cwd(), 'docs');
if (!fs.existsSync(docsDir)) { try{ fs.mkdirSync(docsDir) }catch{} }
app.use('/docs', express.static(docsDir, { setHeaders: (res)=>res.setHeader('Content-Disposition','attachment') }));

app.get('/', (req,res)=>res.send('✅ Alex v1.3.0 core online'));
app.get('/health', (req,res)=>res.json({ status:'UP', version:'1.3.0' }));

const speech = require('./server_speech_filter_v1.3.0');
const flows = require('./patch_flows_pauses_shipping_v1.3.0');

const STATES = { 'LA':'Louisiana','CA':'California','NY':'New York','TX':'Texas','FL':'Florida','IL':'Illinois','PA':'Pennsylvania','OH':'Ohio','GA':'Georgia','NC':'North Carolina','MI':'Michigan','NJ':'New Jersey','VA':'Virginia','WA':'Washington','AZ':'Arizona','MA':'Massachusetts','TN':'Tennessee','IN':'Indiana','MO':'Missouri','MD':'Maryland','WI':'Wisconsin','CO':'Colorado','MN':'Minnesota','SC':'South Carolina','AL':'Alabama','LA':'Louisiana','KY':'Kentucky','OR':'Oregon','OK':'Oklahoma','CT':'Connecticut','UT':'Utah','IA':'Iowa','NV':'Nevada','AR':'Arkansas','MS':'Mississippi','KS':'Kansas','NM':'New Mexico','NE':'Nebraska','ID':'Idaho','WV':'West Virginia','HI':'Hawaii','NH':'New Hampshire','ME':'Maine','RI':'Rhode Island','MT':'Montana','DE':'Delaware','SD':'South Dakota','ND':'North Dakota','AK':'Alaska','VT':'Vermont','WY':'Wyoming' };
function expandStateAbbrev(x){ const u=String(x||'').toUpperCase(); return STATES[u]||x; }
function nowISO(){ return new Date().toISOString(); }

const CARD_RULES = {
  amex:{ lengths:[15], cvv:[4] },
  visa:{ lengths:[13,16,19], cvv:[3] },
  mc:{ lengths:[16], cvv:[3] },
  discover:{ lengths:[16,19], cvv:[3] }
};
function detectCardType(n){ n=(n||'').replace(/\D/g,''); if(!n)return null; if(/^3[47]/.test(n))return'amex'; if(/^4/.test(n))return'visa'; if(/^(5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d{2}|27[01]\d|2720)/.test(n))return'mc'; if(/^(6011|65|64[4-9])/.test(n))return'discover'; return null; }
function luhnCheck(s){ const a=s.replace(/\D/g,'').split('').reverse().map(x=>+x); let sum=0; for(let i=0;i<a.length;i++){ let v=a[i]; if(i%2){ v*=2; if(v>9)v-=9; } sum+=v; } return sum%10===0; }
function validateCard({cardNumber,cvv,expMonth,expYear}){
  const clean=(cardNumber||'').replace(/\D/g,'');
  const type=detectCardType(clean); if(!type)return{ok:false,reason:'Unrecognized card'};
  const spec=CARD_RULES[type];
  if(!spec.lengths.includes(clean.length))return{ok:false,reason:'Invalid length'};
  if(!luhnCheck(clean))return{ok:false,reason:'Luhn failed'};
  if(!cvv || !spec.cvv.includes(String(cvv).length))return{ok:false,reason:'Invalid CVV'};
  const m=+expMonth, y=+expYear; if(!(m>=1&&m<=12))return{ok:false,reason:'Bad month'}; if(!(y>=2024&&y<=2099))return{ok:false,reason:'Bad year'};
  const now=new Date(); const exp=new Date(y, m, 1); if(exp<=now)return{ok:false,reason:'Expired'};
  return {ok:true,type};
}
function validateRouting(s){ s=String(s||'').replace(/\D/g,''); return s.length===9; }
function validateAccount(s){ s=String(s||'').replace(/\D/g,''); return s.length>=7 && s.length<=12; }
function articulateDigitsStable(input){ const map={'0':'zero','1':'one','2':'two','3':'three','4':'four','5':'five','6':'six','7':'seven','8':'eight','9':'nine'}; return String(input||'').replace(/\D/g,'').split('').map(d=>map[d]||d).join(' '); }
function sanitizeSpeech(t){ return String(t||'').replace(/\bSilent\s*\d+\s*S\s*Pause\b/gi,'').replace(/\bAgent waits \d+ms\b/gi,'').replace(/\s{2,}/g,' ').trim(); }
function sizzle(){ const set=["You're going to love it.","It is absolutely amazing.","This product is incredible."]; return set[Math.floor(Math.random()*set.length)]; }
function computeBundlePrice(items,rules){ let subtotal=0; for(const it of (items||[])){ const months=Math.max(1, +it.months||1); const price=+it.unitPrice||0; subtotal+=months*price; } const disc=(rules&&rules.bundleDiscountPct? subtotal*(rules.bundleDiscountPct/100):0); const total=Math.max(0, subtotal-disc); return { subtotal:+subtotal.toFixed(2), discount:+disc.toFixed(2), total:+total.toFixed(2)}; }

app.get('/api/identity',(req,res)=>res.json({ts:nowISO(), identity:"I'm Alex, a Senior Escalation Sales Health Expert here at Health America, and I’d love to help improve your health today."}));
app.post('/api/numbers/articulate',(req,res)=>{ const {value}=req.body||{}; res.json({ts:nowISO(), spoken: articulateDigitsStable(value||'')}); });
app.post('/api/payment/validate',(req,res)=>{ const r=validateCard(req.body||{}); res.status(r.ok?200:422).json({ts:nowISO(),...r}); });
app.post('/api/bank/validate',(req,res)=>{ const {routing,account}=req.body||{}; const rOk=validateRouting(routing); const aOk=validateAccount(account); res.status(rOk&&aOk?200:422).json({ts:nowISO(),routingOk:rOk,accountOk:aOk,ok:rOk&&aOk}); });
app.post('/api/pricing/bundle',(req,res)=>{ const {items,rules}=req.body||{}; res.json({ts:nowISO(), ...computeBundlePrice(items||[], rules||{bundleDiscountPct:0})}); });
app.post('/api/address/confirm',(req,res)=>{ const {line1,city,state,zip}=req.body||{}; const s=expandStateAbbrev(state); res.json({ok:true,speak:sanitizeSpeech(`Confirming your address as ${line1}, ${city}, ${s} ${zip}.`)}); });
app.post('/api/close-order',(req,res)=>{ const {items,rules,card,shippingAddress}=req.body||{}; const price=computeBundlePrice(items||[],rules||{bundleDiscountPct:0}); const cardCheck=validateCard(card||{}); if(!cardCheck.ok) return res.status(422).json({ok:false,reason:cardCheck.reason}); const expanded=expandStateAbbrev(shippingAddress&&shippingAddress.state); const speak=sanitizeSpeech(`Your order is confirmed. Shipping typically arrives in 5 to 7 business days to ${expanded}. ${sizzle()}`); res.json({ok:true,chargeApproved:true,total:price.total,speak}); });

app.post('/api/speech/sanitize',(req,res)=>{ const {text}=req.body||{}; res.json({ts:nowISO(), output: speech.sanitize(text||'')}); });
app.post('/api/speech/paced-health',(req,res)=>{ const {questions}=req.body||{}; res.json({ok:true, sequence: speech.healthPacing(Array.isArray(questions)?questions:[])}); });
app.post('/api/flows/route',(req,res)=>{ const {scenario}=req.body||{}; res.json({ok:true, route: require('./patch_flows_pauses_shipping_v1.3.0').routeScenario(scenario||'default')}); });

app.use((err,req,res,next)=>{ console.error('[error]',err); res.status(500).json({ok:false,error:'Internal error'}); });
app.listen(PORT, ()=>console.log('🚀 Alex core v1.3.0 listening on :'+PORT));
