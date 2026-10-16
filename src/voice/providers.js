// Settings → AI models, as far as GifOS lets an outside program go.
// install() takes a store slug. assign() points a role at an app already in
// the Providers folder. There is no call that accepts a provider this
// program composed and files it into that folder. See
// docs/MEETBOT-BRIDGE.md, "What is missing". This module does not call a
// model and does not speak. A raw URL never goes to Meet Bot.

export const CORS_PROXY = 'https://cors-proxy.gifos.app/';

function endpoint(row) {
  const out = {};
  if (!row) return out;
  if (row.url) out.url = row.url;
  if (row.model) out.model = row.model;
  if (row.key) out.key = row.key;
  if (row.voice) out.voice = row.voice;
  return out;
}

// What to install and assign on a fresh profile, in Settings order.
// Kokoro is installed even when conversation voice is off, because a spoken
// line still uses the assigned text-to-speech provider.
export function installPlan(cfg) {
  const voice = (cfg && cfg.voice) || {};
  const tts = voice.tts || {};
  const steps = [];
  if (cfg && cfg.sttApp) steps.push({ role: 'stt', appId: cfg.sttApp });
  else if (voice.sttUrl) steps.push({ role: 'stt', endpoint: endpoint({ url: voice.sttUrl }) });
  if (tts.engine === 'http') steps.push({ role: 'tts', endpoint: endpoint(tts) });
  else if (tts.engine !== 'none' && tts.app) steps.push({ role: 'tts', appId: tts.app });
  if (voice.llmApp) steps.push({ role: 'smartest', appId: voice.llmApp });
  else if (voice.url || voice.key) steps.push({ role: 'smartest', endpoint: endpoint(voice) });
  return steps;
}

function pageOf(pageUrl) {
  try { return new URL(pageUrl); } catch (e) { return null; }
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

// An https page must not fetch an http model itself: mixed content is blocked,
// and those endpoints do not answer a CORS preflight. The GifOS CORS proxy is
// the host path that keeps the browser call same-origin to an https service.
// https endpoints are left direct, so a key to that host is not sent elsewhere.
// An http page talking to localhost stays direct (a local computer, no mixed content).
export function fetchPlan(target, pageUrl) {
  const page = pageOf(pageUrl);
  let dest = null;
  try { dest = new URL(target); } catch (e) { dest = null; }
  const pageHttps = !!(page && page.protocol === 'https:');
  const destHttp = !!(dest && dest.protocol === 'http:');
  const local = !!(dest && isLocalHost(dest.hostname));
  const crossHttp = !!(destHttp && dest && page && !local && dest.origin !== page.origin);
  if ((pageHttps && destHttp) || crossHttp) {
    return { proxy: true, url: CORS_PROXY, headers: { 'x-gifos-target': String(target) } };
  }
  return { proxy: false, url: String(target), headers: {} };
}

function llmRole(llm) {
  return (llm && llm.provider) || 'smartest';
}

// Turn provider names into what the host voice engine stores.
// An assigned app becomes gifos-provider://<role> with no key.
// An endpoint's URL and key are filled from Settings here, on the host page,
// and are not copied back to the app.
export function expandForHost(settings, ai) {
  const next = settings ? JSON.parse(JSON.stringify(settings)) : {};
  const config = ai || {};
  if (next.llm) {
    const role = llmRole(next.llm);
    const row = config[role] || {};
    const bare = !next.llm.url;
    if (next.llm.provider || bare) {
      if (row.app || row.appId) {
        next.llm = { url: 'gifos-provider://' + role, model: String(row.model || next.llm.model || 'provider') };
      } else if (row.url) {
        next.llm = { url: String(row.url), model: String(row.model || next.llm.model || '') };
        if (row.key) next.llm.key = String(row.key);
      } else if (next.llm.provider) {
        next.llm = { url: 'gifos-provider://' + role, model: String(next.llm.model || 'provider') };
      }
    }
    if (next.llm && next.llm.key === '') delete next.llm.key;
  }
  if (next.tts) {
    const row = config[next.tts.provider || 'tts'] || {};
    const engine = String(next.tts.engine || (row.url ? 'http' : 'kokoro'));
    if (engine === 'none') next.tts = { engine: 'none' };
    else if (engine === 'http') {
      const url = next.tts.url || row.url || '';
      next.tts = { engine: 'http', voice: String(next.tts.voice || row.voice || '') };
      if (url) next.tts.url = String(url);
    } else {
      next.tts = {
        engine: 'kokoro',
        app: String(next.tts.app || row.appId || 'offline-tts-kokoro'),
        voice: String(next.tts.voice || 'af_heart'),
      };
    }
  }
  if (next.stt) next.stt = {};
  return next;
}

// Runs on the GifOS host page, before host-voice.js assigns window.HostVoice.
// It does not synthesize speech. It forwards to GifOS.providers, or to the
// CORS proxy when the page must not call an http endpoint directly.
export function bridgeScript() {
  return '(function(){\n' +
    'var PREFIX="gifos-provider://";\n' +
    'var PROXY="https://cors-proxy.gifos.app/";\n' +
    'function readAi(){try{return JSON.parse(localStorage.getItem("gifos_ai_config")||"{}")||{};}catch(e){return {};}}\n' +
    'function expand(settings){\n' +
    '  var next={}; var k; settings=settings||{};\n' +
    '  for(k in settings) next[k]=settings[k];\n' +
    '  var ai=readAi();\n' +
    '  if(next.llm){\n' +
    '    var role=next.llm.provider||"smartest";\n' +
    '    var row=ai[role]||{};\n' +
    '    var bare=!next.llm.url;\n' +
    '    if(next.llm.provider||bare){\n' +
    '      if(row.app||row.appId){ next.llm={url:PREFIX+role, model:String(row.model||next.llm.model||"provider")}; }\n' +
    '      else if(row.url){ next.llm={url:String(row.url), model:String(row.model||next.llm.model||"")}; if(row.key) next.llm.key=String(row.key); }\n' +
    '      else if(next.llm.provider){ next.llm={url:PREFIX+role, model:String(next.llm.model||"provider")}; }\n' +
    '    }\n' +
    '  }\n' +
    '  if(next.tts){\n' +
    '    var trow=ai[next.tts.provider||"tts"]||{};\n' +
    '    var engine=String(next.tts.engine||(trow.url?"http":"kokoro"));\n' +
    '    if(engine==="none") next.tts={engine:"none"};\n' +
    '    else if(engine==="http"){ var u=next.tts.url||trow.url||""; next.tts={engine:"http", voice:String(next.tts.voice||trow.voice||"")}; if(u) next.tts.url=String(u); }\n' +
    '    else next.tts={engine:"kokoro", app:String(next.tts.app||trow.appId||"offline-tts-kokoro"), voice:String(next.tts.voice||"af_heart")};\n' +
    '  }\n' +
    '  if(next.stt) next.stt={};\n' +
    '  return next;\n' +
    '}\n' +
    'function localHost(h){return h==="localhost"||h==="127.0.0.1"||h==="[::1]";}\n' +
    'function plan(target){\n' +
    '  var page; var dest; try{page=new URL(location.href);}catch(e){page=null;}\n' +
    '  try{dest=new URL(target);}catch(e){dest=null;}\n' +
    '  var pageHttps=!!(page&&page.protocol==="https:");\n' +
    '  var destHttp=!!(dest&&dest.protocol==="http:");\n' +
    '  var local=!!(dest&&localHost(dest.hostname));\n' +
    '  var cross=!!(destHttp&&dest&&page&&!local&&dest.origin!==page.origin);\n' +
    '  if((pageHttps&&destHttp)||cross) return {proxy:true, url:PROXY, headers:{"x-gifos-target":String(target)}};\n' +
    '  return {proxy:false, url:String(target), headers:{}};\n' +
    '}\n' +
    'function sse(text){\n' +
    '  var body="data: "+JSON.stringify({choices:[{delta:{content:String(text||"")}}]})+"\\n\\n";\n' +
    '  return {ok:true, status:200, text:function(){return Promise.resolve(body);}};\n' +
    '}\n' +
    'function wrap(api){\n' +
    '  if(!api||api.__gifosProviders||typeof api.create!=="function") return api;\n' +
    '  var orig=api.create;\n' +
    '  return {\n' +
    '    __gifosProviders:true,\n' +
    '    pullClauses:api.pullClauses,\n' +
    '    scrub:api.scrub,\n' +
    '    create:function(opts){\n' +
    '      opts=opts||{};\n' +
    '      var origFetch=opts.fetch;\n' +
    '      var next={};\n' +
    '      for(var k in opts) next[k]=opts[k];\n' +
    '      next.fetch=function(url, init){\n' +
    '        var s=String(url||"");\n' +
    '        if(s.indexOf(PREFIX)===0){\n' +
    '          var role=s.slice(PREFIX.length).split("/")[0]||"smartest";\n' +
    '          var body={}; try{body=JSON.parse((init&&init.body)||"{}");}catch(e){}\n' +
    '          var g=window.GifOS&&window.GifOS.providers;\n' +
    '          if(!g||typeof g.call!=="function") return Promise.reject(new Error("This page cannot reach the language model."));\n' +
    '          return Promise.resolve(g.call(role,{op:"chat", messages:body.messages||[]})).then(function(out){ return sse(out&&out.text); });\n' +
    '        }\n' +
    '        var p=plan(s);\n' +
    '        var headers={};\n' +
    '        var h=(init&&init.headers)||{};\n' +
    '        for(var hk in h) headers[hk]=h[hk];\n' +
    '        for(var pk in p.headers) headers[pk]=p.headers[pk];\n' +
    '        var fwd={}; for(var ik in (init||{})) fwd[ik]=init[ik];\n' +
    '        fwd.headers=headers;\n' +
    '        return origFetch(p.url, fwd);\n' +
    '      };\n' +
    '      next.tts=function(req){\n' +
    '        var g=window.GifOS&&window.GifOS.providers;\n' +
    '        if(!g||typeof g.call!=="function"||(g.assigned&&!g.assigned("tts"))) return Promise.reject(new Error("Kokoro is not available on this computer."));\n' +
    '        return g.call("tts",{text:(req&&req.text)||"", voice:(req&&req.voice)||"", app:(req&&req.app)||""});\n' +
    '      };\n' +
    '      var eng=orig.call(api, next);\n' +
    '      if(eng&&typeof eng.setVoice==="function"){\n' +
    '        var inner=eng.setVoice;\n' +
    '        eng.setVoice=function(settings){ return inner.call(eng, expand(settings)); };\n' +
    '      }\n' +
    '      return eng;\n' +
    '    }\n' +
    '  };\n' +
    '}\n' +
    'var current=window.HostVoice;\n' +
    'try{\n' +
    '  Object.defineProperty(window,"HostVoice",{configurable:true, enumerable:true,\n' +
    '    get:function(){return current;},\n' +
    '    set:function(v){current=wrap(v);}\n' +
    '  });\n' +
    '}catch(e){}\n' +
    'if(current) current=wrap(current);\n' +
    '})();\n';
}
