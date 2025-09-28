// patch_flows_pauses_shipping_v1.3.0.js — flows v1.3.0
function routeScenario(s){ s=String(s||'default').toLowerCase(); if(s==='numbers')return{path:'numbers-articulation',steps:['capture','repeat-stable','confirm']}; if(s==='payment')return{path:'payment-validation',steps:['capture-card','validate','cvv-exp','confirm']}; if(s==='health')return{path:'health-pacing',steps:['ask-one-by-one','ack','avoid-rapid-fire']}; return{path:'default',steps:['greet','clarify','assist']}; }
function appendShippingIfNeeded(s){ const line=' Shipping typically arrives in 5 to 7 business days.'; return /5\s*to\s*7\s*business\s*days/i.test(s||'')?s:String(s||'')+line; }
module.exports={ routeScenario, appendShippingIfNeeded };
