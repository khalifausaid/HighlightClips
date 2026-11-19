const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PROJECTS = path.join(DATA, 'projects.json');
const MAX_VIDEO = 2 * 1024 * 1024 * 1024;
const MAX_CHAT = 100 * 1024 * 1024;
const PORT = Number(process.env.PORT || 3000);
const LOCAL_YT_DLP = path.join(DATA, 'tools', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const YT_DLP = process.env.YT_DLP || (fs.existsSync(LOCAL_YT_DLP) ? LOCAL_YT_DLP : 'yt-dlp');
const PYTHON = process.env.PYTHON || 'python';
let aiConnection = null;
const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.mp4':'video/mp4', '.srt':'text/plain; charset=utf-8' };
fs.mkdirSync(DATA, { recursive: true });

function readProjects() { try { return JSON.parse(fs.readFileSync(PROJECTS, 'utf8')); } catch { return []; } }
function saveProjects(items) { fs.writeFileSync(PROJECTS, JSON.stringify(items, null, 2)); }
function send(res, code, body, type='application/json; charset=utf-8') { res.writeHead(code, { 'Content-Type': type, 'Cache-Control':'no-store' }); res.end(type.startsWith('application/json') ? JSON.stringify(body) : body); }
function safeName(name) { return path.basename(String(name || 'upload')).replace(/[^\w.() -]/g, '_').slice(0,120) || 'upload'; }
function getProject(id) { return readProjects().find(p => p.id === id); }
function updateProject(project) { const all = readProjects(); const i = all.findIndex(p => p.id === project.id); if (i >= 0) { all[i] = project; saveProjects(all); } }
function mediaTool(name) { return process.env[name.toUpperCase()] || name; }
function validateYoutubeUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch { throw Object.assign(new Error('Enter a valid YouTube video link.'), { status: 400 }); }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const allowed = new Set(['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com','youtu.be','www.youtu.be','youtube-nocookie.com','www.youtube-nocookie.com']);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !allowed.has(host)) {
    throw Object.assign(new Error('Use a public YouTube link (youtube.com or youtu.be).'), { status: 400 });
  }
  const hasVideoId = host.includes('youtu.be') ? parsed.pathname.split('/').filter(Boolean).length > 0 : !!(parsed.searchParams.get('v') || /^\/(shorts|live|embed)\/[^/]+/.test(parsed.pathname));
  if (!hasVideoId) throw Object.assign(new Error('That link does not appear to point to a YouTube video.'), { status: 400 });
  return parsed.toString();
}
async function readJson(req, limit = 64 * 1024) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > limit) throw Object.assign(new Error('Request is too large.'), { status: 413 }); }
  try { return JSON.parse(raw || '{}'); } catch { throw Object.assign(new Error('Invalid request data.'), { status: 400 }); }
}
async function fetchYoutubeVideo(inputUrl, projectId) {
  const url = validateYoutubeUrl(inputUrl);
  const dir = path.join(DATA, projectId); fs.mkdirSync(dir, { recursive: true });
  const template = path.join(dir, 'source.%(ext)s');
  try {
    const { stdout } = await execFileAsync(YT_DLP, [
      '--no-warnings', '--no-progress', '--no-playlist', '--max-filesize', '2G',
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4', '--print', 'title', '--print', 'after_move:filepath', '-o', template, url,
    ], { timeout: 45 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
    const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const printedPath = lines.findLast(line => fs.existsSync(line));
    const title = lines.find(line => line !== printedPath && !path.isAbsolute(line)) || 'YouTube video';
    const sourceName = printedPath && path.resolve(printedPath).startsWith(path.resolve(dir) + path.sep) ? path.basename(printedPath) : null;
    const candidates = fs.readdirSync(dir).filter(name => /^source\./.test(name) && !/\.(part|ytdl)$/.test(name));
    const resolvedName = sourceName || candidates.find(name => /\.mp4$/i.test(name)) || candidates[0];
    if (!resolvedName) throw new Error('YouTube did not provide a downloadable video file.');
    const videoPath = path.join(dir, resolvedName);
    const stat = fs.statSync(videoPath);
    if (stat.size > MAX_VIDEO) throw new Error('Video exceeds the 2 GB processing limit.');
    const info = await probe(videoPath);
    return { videoPath, duration: info.duration, videoName: title, captionPath:null };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    const detail = String(error.stderr || error.message || '');
    if (/private|members-only|sign in|login required|age-restricted|confirm your age/i.test(detail)) {
      throw Object.assign(new Error('This video is private or age-restricted and cannot be fetched without account access.'), { status: 422 });
    }
    if (/live event|is live|live stream/i.test(detail)) throw Object.assign(new Error('This video is still live. Try again after the stream ends.'), { status: 422 });
    throw Object.assign(new Error(`Could not fetch this video: ${detail.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 500) || 'The link may be unavailable or unsupported.'}`), { status: 422 });
  }
}

async function fetchYoutubeCaptions(url, dir) {
  try {
    const output = path.join(dir, 'captions.%(ext)s');
    await execFileAsync(YT_DLP, [
      '--no-warnings','--no-progress','--no-playlist','--skip-download',
      '--write-subs','--write-auto-subs','--sub-langs','en.*,en','--sub-format','vtt',
      '-o',output,url,
    ], { timeout: 120000, maxBuffer: 1024 * 1024 });
    const file = fs.readdirSync(dir).find(name => /^captions.*\.vtt$/i.test(name));
    return file ? path.join(dir,file) : null;
  } catch { return null; }
}

async function callCaptionAI(config,prompt){
  const headers={'Content-Type':'application/json'};let endpoint,body;
  if(config.provider==='openai'){endpoint='https://api.openai.com/v1/chat/completions';headers.Authorization=`Bearer ${config.apiKey}`;body={model:config.model,messages:[{role:'user',content:prompt}],temperature:0.1};}
  else if(config.provider==='groq'){endpoint='https://api.groq.com/openai/v1/chat/completions';headers.Authorization=`Bearer ${config.apiKey}`;body={model:config.model,messages:[{role:'user',content:prompt}],temperature:0.1};}
  else if(config.provider==='anthropic'){endpoint='https://api.anthropic.com/v1/messages';headers['x-api-key']=config.apiKey;headers['anthropic-version']='2023-06-01';body={model:config.model,max_tokens:2048,messages:[{role:'user',content:prompt}]};}
  else if(config.provider==='gemini'){endpoint='https://generativelanguage.googleapis.com/v1beta/interactions';headers['x-goog-api-key']=config.apiKey;body={model:config.model,input:prompt,store:false};}
  else throw new Error('Choose a supported AI provider.');
  const response=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(90000)});const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error?.message||data.message||`AI provider returned ${response.status}.`);
  if(config.provider==='openai'||config.provider==='groq')return data.choices?.[0]?.message?.content||'';
  if(config.provider==='anthropic')return data.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')||'';
  return (data.steps||[]).filter(x=>x.type==='model_output').flatMap(x=>x.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
}
async function transcribeClipGroq(project,clip,wavPath,mode,vttPath){
  const data=new FormData();data.append('file',new Blob([fs.readFileSync(wavPath)]),`highlight-${clip.id}.wav`);data.append('model','whisper-large-v3');data.append('response_format','verbose_json');data.append('timestamp_granularities[]','segment');if(mode==='english')data.append('language','en');
  project.transcriptionProgress={stage:'transcribing',percent:0,remainingSeconds:20,model:'Groq Whisper Large'};updateProject(project);
  const response=await fetch('https://api.groq.com/openai/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${aiConnection.apiKey}`},body:data,signal:AbortSignal.timeout(120000)}),result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(result.error?.message||`Groq transcription failed (${response.status}).`);
  const segments=(result.segments||[]).filter(s=>s.text&&s.end>s.start);if(!segments.length)throw new Error('No speech was detected in the highlighted clip.');
  project.detectedCaptionLanguage=String(result.language||'unknown').toLowerCase();project.transcriptionProgress={stage:'transcribing',percent:100,remainingSeconds:0,detectedLanguage:project.detectedCaptionLanguage};
  fs.writeFileSync(vttPath,'WEBVTT\n\n'+segments.map(s=>`${vttTime(s.start)} --> ${vttTime(s.end)}\n${String(s.text).trim()}`).join('\n\n')+'\n','utf8');
}
async function translateCaptions(cues,language){
  if(!aiConnection||!cues.length)return cues;
  let languageName=language||'the detected language';try{languageName=new Intl.DisplayNames(['en'],{type:'language'}).of(language)||languageName}catch{}
  const prompt=`Translate these video subtitle lines from ${languageName} into natural, concise English. Preserve meaning and tone. Return only a JSON array of strings with exactly ${cues.length} items in the original order. Do not add explanations.\n${JSON.stringify(cues.map(c=>c.text))}`;
  const response=await callCaptionAI(aiConnection,prompt);const parsed=JSON.parse(response.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));
  if(!Array.isArray(parsed)||parsed.length!==cues.length||parsed.some(x=>typeof x!=='string'))throw new Error('The connected AI returned captions in an unexpected format.');
  return cues.map((cue,i)=>({...cue,text:parsed[i].trim()}));
}
async function generateCaptions(project,clip,settings={}) {
  const dir=path.dirname(project.videoPath),wavPath=path.join(dir,`speech-${clip.id}.wav`),mode=['original','english'].includes(settings.captionLanguage)?settings.captionLanguage:'translated',whisperModel=['tiny','base','small'].includes(settings.captionModel)?settings.captionModel:'base',providerTag=mode==='translated'&&aiConnection?crypto.createHash('sha1').update(`${aiConnection.provider}:${aiConnection.model}`).digest('hex').slice(0,8):'local',helperMode=mode==='translated'&&aiConnection?'original':mode,vttPath=path.join(dir,`captions-${clip.id}-${mode}-${whisperModel}-${providerTag}.vtt`);
  if(fs.existsSync(vttPath)&&parseVtt(fs.readFileSync(vttPath,'utf8')).length)return vttPath;
  try {
    const duration=clip.end-clip.start;project.transcriptionProgress={stage:'extracting',percent:0,remainingSeconds:Math.max(2,Math.round(duration*.25))};updateProject(project);
    await execFileAsync(mediaTool('ffmpeg'),['-y','-v','error','-ss',String(clip.start),'-i',project.videoPath,'-t',String(duration),'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',wavPath],{timeout:10*60*1000,maxBuffer:2*1024*1024});
    if(aiConnection?.provider==='groq')await transcribeClipGroq(project,clip,wavPath,mode,vttPath);
    else await new Promise((resolve,reject)=>{
      const proc=spawn(PYTHON,[path.join(ROOT,'transcribe.py'),wavPath,vttPath,helperMode,'auto',whisperModel],{stdio:['ignore','pipe','pipe']});let stdoutBuffer='',stderr='';let lastSave=0;
      const timeout=setTimeout(()=>proc.kill(),20*60*1000);
      proc.stdout.on('data',chunk=>{
        stdoutBuffer+=chunk.toString();const lines=stdoutBuffer.split(/\r?\n/);stdoutBuffer=lines.pop()||'';
        for(const line of lines){try{const progress=JSON.parse(line);if(progress.stage){project.transcriptionProgress=progress;if(progress.detectedLanguage)project.detectedCaptionLanguage=progress.detectedLanguage;const now=Date.now();if(now-lastSave>1000){updateProject(project);lastSave=now;}}}catch{}}
      });
      proc.stderr.on('data',chunk=>{if(stderr.length<12000)stderr+=chunk.toString();});
      proc.on('error',error=>{clearTimeout(timeout);reject(new Error(`Python could not start: ${error.message}`));});
      proc.on('close',code=>{clearTimeout(timeout);if(code===0)resolve();else reject(new Error(stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(' ')||`Caption generation stopped (exit ${code}).`));});
    });
    if(mode==='translated'&&aiConnection){project.transcriptionProgress={stage:'translating',percent:0,remainingSeconds:20};updateProject(project);const translated=await translateCaptions(parseVtt(fs.readFileSync(vttPath,'utf8')),project.detectedCaptionLanguage);fs.writeFileSync(vttPath,'WEBVTT\n\n'+translated.map(c=>`${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}`).join('\n\n')+'\n','utf8');project.captionTranslation='ai';}
    else project.captionTranslation=mode==='translated'?'whisper':'transcribe';
    if(fs.existsSync(vttPath)&&parseVtt(fs.readFileSync(vttPath,'utf8')).length){
      project.captionSource='generated';
      return vttPath;
    }
    return null;
  } catch(error) {
    project.captionGenerationError=String(error.stderr||error.message||'Speech transcription failed.').split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0,400);
    return null;
  } finally { project.transcriptionProgress=null;updateProject(project);try{fs.rmSync(wavPath,{force:true})}catch{} }
}

function parseMultipart(req, boundary, limits) {
  return new Promise((resolve, reject) => {
    const chunks=[]; let size=0; const cap=limits.video+limits.chat+65536;
    req.on('data', c => { size += c.length; if(size>cap) { reject(Object.assign(new Error('Upload is too large.'),{status:413})); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => {
      try {
        const body=Buffer.concat(chunks); const marker=Buffer.from('--'+boundary); const fields={}; let pos=0;
        while((pos=body.indexOf(marker,pos))!==-1) {
          pos += marker.length; if(body.subarray(pos,pos+2).toString()==='--') break;
          if(body.subarray(pos,pos+2).toString()==='\r\n') pos+=2;
          const headEnd=body.indexOf(Buffer.from('\r\n\r\n'),pos); if(headEnd<0) break;
          const headers=body.subarray(pos,headEnd).toString('utf8'); const next=body.indexOf(marker,headEnd+4); if(next<0) break;
          let dataEnd=next; if(body.subarray(dataEnd-2,dataEnd).toString()==='\r\n') dataEnd-=2;
          const content=body.subarray(headEnd+4,dataEnd);
          const disposition=headers.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1]||'';
          const field=disposition.match(/name="([^"]+)"/)?.[1]; const filename=disposition.match(/filename="([^"]*)"/)?.[1];
          if(field && filename) fields[field]={ name:safeName(filename), data:content };
          else if(field) fields[field]=content.toString('utf8');
          pos=next;
        }
        resolve(fields);
      } catch(e) { reject(e); }
    });
    req.on('error',reject);
  });
}

function runFfmpeg(args, maxBytes=30*1024*1024) {
  return new Promise((resolve,reject)=>{
    const proc=spawn(mediaTool('ffmpeg'),args,{stdio:['ignore','pipe','pipe']}); let out=[]; let bytes=0; let err='';
    proc.stdout.on('data',c=>{bytes+=c.length;if(bytes>maxBytes){proc.kill();reject(new Error('Decoded audio exceeds the processing limit.'));return;}out.push(c);});
    proc.stderr.on('data',c=>{if(err.length<12000)err+=c.toString();});
    proc.on('error',e=>reject(new Error(`FFmpeg could not start: ${e.message}`)));
    proc.on('close',code=>code===0?resolve(Buffer.concat(out)):reject(new Error(err.split('\n').filter(Boolean).slice(-3).join(' ')||'FFmpeg failed.')));
  });
}
async function probe(file) {
  const {stdout}=await execFileAsync(mediaTool('ffprobe'),['-v','error','-show_entries','format=duration:stream=codec_type,width,height','-of','json',file],{timeout:30000,maxBuffer:1024*1024});
  const data=JSON.parse(stdout); const duration=Number(data.format?.duration); if(!Number.isFinite(duration)||duration<=0) throw new Error('Could not read a valid video duration.');
  return {duration,width:data.streams?.find(x=>x.codec_type==='video')?.width||0,height:data.streams?.find(x=>x.codec_type==='video')?.height||0};
}
function parseVttTime(value) {
  const parts=value.trim().replace(',','.').split(':').map(Number);
  if(parts.some(n=>!Number.isFinite(n)))return 0;
  return parts.length===3?parts[0]*3600+parts[1]*60+parts[2]:parts[0]*60+parts[1];
}
function vttTime(seconds){const ms=Math.max(0,Math.round(seconds*1000)),h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000),s=Math.floor(ms%60000/1000),r=ms%1000;return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(r).padStart(3,'0')}`;}
function parseVtt(content) {
  const cues=[];const blocks=content.replace(/^\uFEFF/,'').split(/\r?\n\s*\r?\n/);
  for(const block of blocks){
    const lines=block.split(/\r?\n/);const i=lines.findIndex(line=>line.includes('-->'));if(i<0)continue;
    const [a,b]=lines[i].split('-->').map(x=>x.trim().split(/\s+/)[0]);
    const text=lines.slice(i+1).join(' ').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/\s+/g,' ').trim();
    const start=parseVttTime(a),end=parseVttTime(b);if(text&&end>start)cues.push({start,end,text});
  }
  return cues;
}
const HOOK_WORDS=new Set(['actually','amazing','best','biggest','crazy','discover','finally','first','greatest','here','how','important','insane','imagine','mistake','never','now','only','problem','secret','solution','surprise','truth','wait','what','why','win','worst','wow']);
function hookStrength(text) {
  const words=(text.toLowerCase().match(/[a-z0-9']+/g)||[]);let hits=0;for(const word of words)if(HOOK_WORDS.has(word))hits++;
  const punct=(/[!?]/.test(text)?0.16:0)+(/\d/.test(text)?0.08:0);const length=words.length>=5&&words.length<=28?0.14:0;
  return Math.min(1,0.12+Math.min(0.58,hits*0.16)+punct+length);
}
function srtTime(seconds) { const ms=Math.max(0,Math.round(seconds*1000));const h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000),s=Math.floor(ms%60000/1000),rem=ms%1000;return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(rem).padStart(3,'0')}`; }
function makeClipSrt(cues,clip,captionStyle='creator') {
  const selected=cues.filter(c=>c.end>clip.start&&c.start<clip.end),events=[];
  for(const cue of selected){
    const raw=cue.text.trim(),words=raw.split(/\s+/).filter(Boolean),groups=[];if(words.length===1&&Array.from(words[0]).length>30){const chars=Array.from(words[0]);for(let i=0;i<chars.length;i+=16)groups.push(chars.slice(i,i+16).join(''));}let line='';
    if(!groups.length)for(const word of words){if(line&&(line.length+word.length+1>30||line.split(/\s+/).length>=5)){groups.push(line);line='';}line+=(line?' ':'')+word;}
    if(line)groups.push(line);if(!groups.length)continue;
    const start=Math.max(0,cue.start-clip.start),end=Math.min(clip.end-clip.start,cue.end-clip.start),part=(end-start)/groups.length;
    groups.forEach((text,index)=>{
      const safe=text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const color=captionStyle==='neon'?'#65E5FF':'#D6F379';const styled=captionStyle==='creator'||captionStyle==='neon'?safe.replace(/\b(actually|amazing|best|biggest|crazy|finally|first|greatest|how|important|insane|mistake|never|problem|secret|solution|truth|wait|what|why|win|worst|wow)\b/gi,`<font color="${color}"><b>$1</b></font>`):safe;
      events.push({start:start+part*index,end:index===groups.length-1?end:start+part*(index+1),text:styled});
    });
  }
  return events.map((c,i)=>`${i+1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}`).join('\n\n')+'\n';
}
async function analyze(project) {
  project.status='analyzing';project.transcriptionProgress={stage:'scanning',percent:0,remainingSeconds:Math.max(8,Math.round((project.duration||60)*.08))};project.updatedAt=new Date().toISOString();updateProject(project);
  try {
    const info=await probe(project.videoPath); project.duration=info.duration; project.sourceWidth=info.width; project.sourceHeight=info.height;
    const pcm=await runFfmpeg(['-v','error','-i',project.videoPath,'-vn','-ac','1','-ar','8000','-f','f32le','pipe:1'],120*1024*1024);
    const samples=new Float32Array(pcm.buffer,pcm.byteOffset,Math.floor(pcm.length/4)); const rate=8000; const secCount=Math.ceil(samples.length/rate); const levels=[];
    for(let s=0;s<secCount;s++){let sum=0,n=Math.min(rate,samples.length-s*rate);for(let i=0;i<n;i++){const v=samples[s*rate+i];sum+=v*v;}levels.push(Math.sqrt(sum/Math.max(n,1)));}
    const sorted=[...levels].sort((a,b)=>a-b);const baseline=sorted[Math.floor(sorted.length*.55)]||0.00001;const median=sorted[Math.floor(sorted.length*.5)]||0;const peakLevel=sorted.at(-1)||1;const meanLevel=levels.reduce((a,b)=>a+b,0)/Math.max(levels.length,1);const threshold=Math.max(median+(project.sensitivity==='High'?0.12:project.sensitivity==='Low'?0.34:0.22)*peakLevel,baseline*1.7,0.003);
    const clipLen=Math.min(35,Math.max(12,info.duration));const maxStart=Math.max(0,info.duration-clipLen);const candidates=[];
    levels.forEach((value,s)=>{if(value<threshold)return;const start=Math.max(0,Math.min(maxStart,s-clipLen*.58));const end=Math.min(info.duration,start+clipLen);const energyScore=Math.max(0,value-baseline)/Math.max(baseline,0.003);const window=levels.slice(Math.floor(start),Math.ceil(end));const peak=Math.max(...window,0);const average=window.reduce((a,b)=>a+b,0)/Math.max(window.length,1);const engagement=Math.min(1,.62*peak/Math.max(peakLevel,.001)+.38*average/Math.max(meanLevel*2,.001));candidates.push({start,end,score:Math.min(99,Math.round(42+engagement*45+Math.min(12,energyScore*2))),peak:s,reason:`Strong audio moment · ${energyScore.toFixed(1)}× above baseline`,audioPeak:energyScore});});
    candidates.sort((a,b)=>b.score-a.score);const clips=[];
    for(const point of candidates){if(clips.length>=10)break;if(point.score<48)continue;const start=Math.max(0,Math.min(maxStart,point.start));const end=Math.min(info.duration,start+clipLen);if(clips.some(c=>start<c.end+1.5&&end>c.start-1.5))continue;clips.push({id:crypto.randomUUID(),start:Number(start.toFixed(2)),end:Number(end.toFixed(2)),score:Math.min(99,point.score),reason:point.reason,hook:point.hook||'',peak:Number(point.peak.toFixed(2)),exported:false});}
    clips.sort((a,b)=>a.start-b.start);project.clips=clips;project.captionCount=0;project.status='ready';project.analysisNote=clips.length?'Highlights found from the full video. Captions are created only for the selected clip when you export it.':'No clear moments found. Try High sensitivity or another video.';
  } catch(e){project.status='error';project.error=e.message;}
  project.transcriptionProgress=null;
  project.updatedAt=new Date().toISOString();updateProject(project);return project;
}

function parseTime(sec){const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=Math.floor(sec%60),ms=Math.floor((sec%1)*1000);return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;}
async function exportClip(project,clip,settings={}) {
  const dir=path.dirname(project.videoPath),name=`clip-${clip.id}.mp4`,dest=path.join(dir,name),duration=clip.end-clip.start;
  const ratios={'9:16':9/16,'4:5':4/5,'1:1':1,'16:9':16/9};const ratio=Object.hasOwn(ratios,settings.ratio)?settings.ratio:'9:16';
  const shortEdge=({720:720,1080:1080,1440:1440,2160:2160})[Number(settings.resolution)]||1080;const aspect=ratios[ratio];
  const width=Math.round((aspect<1?shortEdge:shortEdge*aspect)/2)*2,height=Math.round((aspect<1?shortEdge/aspect:shortEdge)/2)*2;
  const layout=['fill','fit','blur'].includes(settings.layout)?settings.layout:'fill';const captionStyle=['creator','classic','boxed','minimal','neon'].includes(settings.captionStyle)?settings.captionStyle:'creator';
  const quality=settings.quality||'balanced',crf=quality==='high'?18:quality==='small'?28:23,preset=quality==='high'?'slow':quality==='small'?'veryfast':'medium';
  let subtitleFilter='';let srtPath=null;
  if(settings.captions!==false){
    const vttPath=await generateCaptions(project,clip,settings);
    if(!vttPath)throw new Error(project.captionGenerationError||'Captions could not be generated for this clip.');
    const cues=parseVtt(fs.readFileSync(vttPath,'utf8'));srtPath=path.join(dir,`clip-${clip.id}.srt`);fs.writeFileSync(srtPath,makeClipSrt(cues,{start:0,end:duration},captionStyle),'utf8');clip.captionLanguage=settings.captionLanguage==='original'?(project.detectedCaptionLanguage||'original'):'English';
    const escaped=path.resolve(srtPath).replace(/\\/g,'/').replace(/^([A-Za-z]):/,'$1\\:').replace(/'/g,"\\'");
    const sizeBase={creator:54,classic:46,boxed:46,minimal:40,neon:54}[captionStyle],fontSize=Math.round(sizeBase*height/1920),margin=Math.round(height*.12);
    const captionStyles={
      creator:`FontName=Arial,FontSize=${fontSize},Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010,BorderStyle=1,Outline=4,Shadow=2,Alignment=2,MarginV=${margin}`,
      classic:`FontName=Arial,FontSize=${fontSize},PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010,BorderStyle=1,Outline=3,Shadow=1,Alignment=2,MarginV=${margin}`,
      boxed:`FontName=Arial,FontSize=${fontSize},Bold=1,PrimaryColour=&H00FFFFFF,BackColour=&HBB101010,BorderStyle=3,Outline=0,Shadow=0,Alignment=2,MarginV=${margin}`,
      minimal:`FontName=Arial,FontSize=${fontSize},PrimaryColour=&H00FFFFFF,OutlineColour=&H50000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=${margin}`,
      neon:`FontName=Arial,FontSize=${fontSize},Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00B43CFF,BorderStyle=1,Outline=4,Shadow=2,Alignment=2,MarginV=${margin}`,
    };
    subtitleFilter=`subtitles='${escaped}':force_style='${captionStyles[captionStyle]}'`;clip.captionFile=path.basename(srtPath);
  }
  const inputArgs=['-y','-v','error','-ss',String(clip.start),'-i',project.videoPath,'-t',String(duration)];let renderArgs;
  if(layout==='blur'){
    const graph=`[0:v]split=2[bg][fg];[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=26:12[bgf];[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[fgf];[bgf][fgf]overlay=(W-w)/2:(H-h)/2${subtitleFilter?`,${subtitleFilter}`:''}[vout]`;
    renderArgs=['-filter_complex',graph,'-map','[vout]','-map','0:a?'];
  }else{
    let vf=layout==='fill'?`scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`:`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
    if(subtitleFilter)vf+=`,${subtitleFilter}`;renderArgs=['-vf',vf];
  }
  const estimate=Math.min(480,Math.max(8,Math.round(duration*(Number(settings.resolution||1080)/720)**1.4*(quality==='high'?.9:quality==='small'?.3:.45))));
  project.exportProgress={stage:'rendering',percent:0,remainingSeconds:estimate};updateProject(project);
  try{
    await new Promise((resolve,reject)=>{
      const proc=spawn(mediaTool('ffmpeg'),[...inputArgs,...renderArgs,'-c:v','libx264','-preset',preset,'-crf',String(crf),'-c:a','aac','-b:a','192k','-movflags','+faststart','-progress','pipe:1','-nostats',dest],{stdio:['ignore','pipe','pipe']});let buffer='',stderr='',lastSave=0;const start=Date.now(),timeout=setTimeout(()=>proc.kill(),30*60*1000);
      proc.stdout.on('data',chunk=>{buffer+=chunk.toString();const lines=buffer.split(/\r?\n/);buffer=lines.pop()||'';for(const line of lines){const [key,value]=line.split('=');if(key==='out_time_us'){const done=Math.min(duration,Number(value)/1e6),fraction=Math.min(.99,done/duration),elapsed=(Date.now()-start)/1000,measured=fraction>.05?Math.round(elapsed*(1-fraction)/fraction):estimate;project.exportProgress={stage:'rendering',percent:Math.round(fraction*100),remainingSeconds:Math.min(estimate,Math.max(1,measured))};if(Date.now()-lastSave>900){updateProject(project);lastSave=Date.now();}}}});
      proc.stderr.on('data',chunk=>{if(stderr.length<12000)stderr+=chunk.toString();});proc.on('error',e=>{clearTimeout(timeout);reject(new Error(`FFmpeg could not start: ${e.message}`));});proc.on('close',code=>{clearTimeout(timeout);code===0?resolve():reject(new Error(stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' ')||'FFmpeg export failed.'));});
    });
    clip.exported=true;clip.file=name;clip.captionFile=srtPath?path.basename(srtPath):null;updateProject(project);return dest;
  }finally{project.exportProgress=null;updateProject(project);}
}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  try {
    if(req.method==='GET'&&url.pathname==='/api/health')return send(res,200,{ok:true,mode:'local'});
    if(req.method==='GET'&&url.pathname==='/api/ai/status')return send(res,200,{connected:!!aiConnection,provider:aiConnection?.provider||null,model:aiConnection?.model||null});
    if(req.method==='POST'&&url.pathname==='/api/ai/connect'){
      const body=await readJson(req);const provider=['openai','gemini','anthropic','groq'].includes(body.provider)?body.provider:null,apiKey=String(body.apiKey||'').trim(),model=String(body.model||'').trim();
      if(!provider||!apiKey||!model)return send(res,400,{error:'Choose a provider and enter its API key and model.'});
      const candidate={provider,apiKey,model};const result=await callCaptionAI(candidate,'Reply with the single word OK.');if(!result.trim())return send(res,422,{error:'The provider connected but returned an empty reply.'});aiConnection=candidate;return send(res,200,{connected:true,provider,model});
    }
    if(req.method==='GET'&&url.pathname==='/api/projects')return send(res,200,readProjects().map(({videoPath,chatPath,captionPath,...p})=>p));
    const projectMatch=url.pathname.match(/^\/api\/projects\/([\w-]+)$/);
    if(req.method==='GET'&&projectMatch){const p=getProject(projectMatch[1]);if(!p)return send(res,404,{error:'Project not found.'});const{videoPath,chatPath,captionPath,...safe}=p;return send(res,200,safe);}
    if(req.method==='POST'&&url.pathname==='/api/projects/url'){
      const type=req.headers['content-type']||'';
      const body=type.includes('multipart/form-data')?await (async()=>{const boundary=type.match(/boundary=(?:"([^"]+)"|([^;]+))/i);if(!boundary)throw Object.assign(new Error('Invalid upload data.'),{status:400});return parseMultipart(req,boundary[1]||boundary[2],{video:0,chat:MAX_CHAT});})():await readJson(req);
      const id=crypto.randomUUID();
      const result=await fetchYoutubeVideo(body.videoUrl,id);
      let chatPath=null;if(body.chatReplay?.data?.length){if(body.chatReplay.data.length>MAX_CHAT){fs.rmSync(path.dirname(result.videoPath),{recursive:true,force:true});return send(res,413,{error:'Chat replay exceeds the 100 MB limit.'});}chatPath=path.join(path.dirname(result.videoPath),safeName(body.chatReplay.name));fs.writeFileSync(chatPath,body.chatReplay.data);}
      const project={id,title:String(body.title||result.videoName||'YouTube highlight project').slice(0,100),videoName:result.videoName,videoUrl:body.videoUrl,videoPath:result.videoPath,captionPath:result.captionPath,chatPath,chatName:chatPath?body.chatReplay.name:null,source:'youtube_url',ownershipConfirmed:null,chatOwnershipConfirmed:null,sensitivity:['Low','Medium','High'].includes(body.sensitivity)?body.sensitivity:'Medium',status:'uploaded',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),duration:result.duration,clips:[]};
      const all=readProjects();all.unshift(project);saveProjects(all);const{videoPath:hiddenVideoPath,chatPath:hiddenChatPath,captionPath:hiddenCaptionPath,...safe}=project;return send(res,201,safe);
    }
    if(req.method==='POST'&&url.pathname==='/api/projects'){
      const type=req.headers['content-type']||'';const boundary=type.match(/boundary=(?:"([^"]+)"|([^;]+))/i);if(!type.includes('multipart/form-data')||!boundary)return send(res,400,{error:'Choose a video file to upload.'});
      const f=await parseMultipart(req,boundary[1]||boundary[2],{video:MAX_VIDEO,chat:MAX_CHAT});
      if(!f.video?.data?.length)return send(res,400,{error:'Choose a video file to upload.'});
      if(f.video.data.length>MAX_VIDEO)return send(res,413,{error:'Video exceeds the 2 GB limit.'});
      if(f.chatReplay?.data?.length>MAX_CHAT)return send(res,413,{error:'Chat replay exceeds the 100 MB limit.'});
      const id=crypto.randomUUID();const dir=path.join(DATA,id);fs.mkdirSync(dir,{recursive:true});const videoPath=path.join(dir,safeName(f.video.name));fs.writeFileSync(videoPath,f.video.data);
      let chatPath=null;if(f.chatReplay?.data?.length){chatPath=path.join(dir,safeName(f.chatReplay.name));fs.writeFileSync(chatPath,f.chatReplay.data);}
      const project={id,title:String(f.title||'New highlight project').slice(0,100),videoName:f.video.name,chatName:chatPath?f.chatReplay.name:null,videoPath,chatPath,ownershipConfirmed:null,chatOwnershipConfirmed:null,sensitivity:['Low','Medium','High'].includes(f.sensitivity)?f.sensitivity:'Medium',status:'uploaded',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),duration:null,clips:[]};
      const all=readProjects();all.unshift(project);saveProjects(all);const {videoPath:_,chatPath:__,...safe}=project;return send(res,201,safe);
    }
    const sourceMatch=url.pathname.match(/^\/api\/projects\/([\w-]+)\/source$/);
    if(req.method==='GET'&&sourceMatch){
      const p=getProject(sourceMatch[1]);if(!p||!fs.existsSync(p.videoPath))return send(res,404,{error:'Source video not found.'});
      const stat=fs.statSync(p.videoPath),range=req.headers.range;res.setHeader('Content-Type','video/mp4');res.setHeader('Accept-Ranges','bytes');
      if(!range){res.writeHead(200,{'Content-Length':stat.size});return fs.createReadStream(p.videoPath).pipe(res);}
      const match=range.match(/^bytes=(\d*)-(\d*)$/);if(!match)return res.writeHead(416,{'Content-Range':`bytes */${stat.size}`}).end();
      const start=match[1]?Number(match[1]):0,end=Math.min(match[2]?Number(match[2]):stat.size-1,stat.size-1);
      if(start>end||start>=stat.size)return res.writeHead(416,{'Content-Range':`bytes */${stat.size}`}).end();
      res.writeHead(206,{'Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${stat.size}`});return fs.createReadStream(p.videoPath,{start,end}).pipe(res);
    }
    const analyzeMatch=url.pathname.match(/^\/api\/projects\/([\w-]+)\/analyze$/);
    if(req.method==='POST'&&analyzeMatch){const p=getProject(analyzeMatch[1]);if(!p)return send(res,404,{error:'Project not found.'});await analyze(p);const{videoPath,chatPath,captionPath,...safe}=p;return send(res,p.status==='error'?422:200,safe);}
    const exportMatch=url.pathname.match(/^\/api\/projects\/([\w-]+)\/clips\/([\w-]+)\/export$/);
    if(req.method==='POST'&&exportMatch){const p=getProject(exportMatch[1]);if(!p)return send(res,404,{error:'Project not found.'});const c=p.clips.find(x=>x.id===exportMatch[2]);if(!c)return send(res,404,{error:'Clip not found.'});let raw='';for await(const d of req)raw+=d;const settings=raw?JSON.parse(raw):{};await exportClip(p,c,settings);return send(res,200,{ok:true,file:c.file});}
    const downloadMatch=url.pathname.match(/^\/api\/projects\/([\w-]+)\/files\/([\w-]+)$/);
    if(req.method==='GET'&&downloadMatch){const p=getProject(downloadMatch[1]);if(!p)return send(res,404,{error:'Project not found.'});const c=p.clips.find(x=>x.id===downloadMatch[2]);if(!c?.exported)return send(res,404,{error:'Export not found.'});const file=path.join(path.dirname(p.videoPath),c.file);res.writeHead(200,{'Content-Type':'video/mp4','Content-Disposition':`attachment; filename="${c.file}"`});return fs.createReadStream(file).pipe(res);}
    if(req.method==='DELETE'&&url.pathname.startsWith('/api/projects/')){const id=url.pathname.split('/').at(-1),p=getProject(id);if(!p)return send(res,404,{error:'Project not found.'});fs.rmSync(path.dirname(p.videoPath),{recursive:true,force:true});saveProjects(readProjects().filter(x=>x.id!==id));return send(res,200,{ok:true});}
    if(req.method==='GET') {const requested=decodeURIComponent(url.pathname==='/'?'index.html':url.pathname.slice(1));const file=path.resolve(ROOT,requested);if(!file.startsWith(ROOT+path.sep))return send(res,404,{error:'Not found.'});if(fs.existsSync(file)&&fs.statSync(file).isFile())return res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream'}).end(fs.readFileSync(file));}
    return send(res,404,{error:'Not found.'});
  } catch(e){console.error(e);if(!res.headersSent)send(res,e.status||500,{error:e.message||'Something went wrong.'});}
});
server.listen(PORT,'127.0.0.1',()=>console.log(`HighlightClips ready at http://localhost:${PORT} (local single-user mode)`));

