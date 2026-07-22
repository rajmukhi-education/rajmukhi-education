const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PORT = Number(process.env.PORT || 3000);
const APP_VERSION = 'v61-production';
const DB_FILE = path.join(__dirname, 'data.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const BACKUP_DIR = path.join(__dirname, 'backups');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@rajmukhi.education';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1234';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const USING_DEFAULT_ADMIN_CREDENTIALS = !process.env.ADMIN_EMAIL && !process.env.ADMIN_PASSWORD;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT = 25;
const rateBuckets = new Map();
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
const defaultDB = { users: [], students: [], courses: [], lessons: [], enrollments: [], progress: [], notes: [], notices: [], videos: [], tests: [], results: [], sessions: [], uploads: [], certificates: [], security_events: [], twofa_challenges: [], security_alerts: [] };
function loadDB(){try{if(!fs.existsSync(DB_FILE)){fs.writeFileSync(DB_FILE,JSON.stringify(defaultDB,null,2));return structuredClone(defaultDB)}const d=JSON.parse(fs.readFileSync(DB_FILE,'utf8'));return {...defaultDB,...d,users:d.users||[],sessions:d.sessions||[],videos:d.videos||[],uploads:d.uploads||[],lessons:d.lessons||[],enrollments:d.enrollments||[],progress:d.progress||[],certificates:d.certificates||[],security_events:d.security_events||[],twofa_challenges:d.twofa_challenges||[],security_alerts:d.security_alerts||[]}}catch{return structuredClone(defaultDB)}}
let db=loadDB();
// V53: ensure the initial educational catalog is available even if a previous
// runtime deployment created an empty data.json. Existing user/content data is
// preserved; only missing starter catalog entries are restored.
function ensureStarterCatalog(){
 const courses=[
  {id:'course-science',title:'General Science',description:'Physics, Chemistry, Biology और सामान्य विज्ञान',lessons:100,created_at:'2026-07-20T00:00:00.000Z'},
  {id:'course-math',title:'Mathematics',description:'Basic से Advanced Mathematics',lessons:80,created_at:'2026-07-20T00:00:00.000Z'},
  {id:'course-reasoning',title:'Reasoning',description:'Verbal और Non-Verbal Reasoning',lessons:65,created_at:'2026-07-20T00:00:00.000Z'}
 ];
 const lessons=[
  {id:'lesson-science-1',course_id:'course-science',title:'Introduction to General Science',description:'विज्ञान की मूल अवधारणाएँ',content:'यह lesson विज्ञान की मूल अवधारणाओं से शुरू होता है।',order:1},
  {id:'lesson-math-1',course_id:'course-math',title:'Number System Basics',description:'संख्या पद्धति की शुरुआत',content:'Natural, whole और integer numbers का परिचय।',order:1}
 ];
 const notes=[
  {id:'note-science',title:'General Science Notes',description:'Study material',content:'विज्ञान निरीक्षण, प्रयोग, तर्क और प्रमाण पर आधारित ज्ञान का व्यवस्थित अध्ययन है।\n\nमुख्य शाखाएँ: भौतिक विज्ञान, रसायन विज्ञान और जीव विज्ञान।'},
  {id:'note-math',title:'Mathematics Formula Book',description:'Important formulas',content:'प्रतिशत = (भाग ÷ कुल) × 100\n\nऔसत = कुल योग ÷ पदों की संख्या'},
  {id:'note-reasoning',title:'Reasoning Practice Notes',description:'Topic-wise notes',content:'Reasoning में pattern, analogy, classification और logical relations को पहचानना शामिल है।'}
 ];
 const tests=[{id:'test-gs-1',title:'General Science Quiz',course_id:'course-science',questions:[{id:1,question:'भारत की राजधानी क्या है?',options:['पटना','नई दिल्ली','मुंबई'],answer:1},{id:2,question:'पानी का रासायनिक सूत्र क्या है?',options:['H₂O','CO₂','O₂'],answer:0}]}];
 let changed=false;
 if(!Array.isArray(db.courses)||db.courses.length===0){db.courses=courses;changed=true}
 if(!Array.isArray(db.lessons)||db.lessons.length===0){db.lessons=lessons;changed=true}
 if(!Array.isArray(db.notes)||db.notes.length===0){db.notes=notes;changed=true}
 if(!Array.isArray(db.tests)||db.tests.length===0){db.tests=tests;changed=true}
 if(!Array.isArray(db.notices)||db.notices.length===0){db.notices=[{id:'notice-welcome',title:'Welcome',message:'Rajmukhi Education में आपका स्वागत है।',created_at:new Date().toISOString()}];changed=true}
 if(changed) saveDB();
}
function saveDB(){
 const tmp=DB_FILE+'.tmp';
 const payload=JSON.stringify(db,null,2);
 fs.writeFileSync(tmp,payload,{encoding:'utf8',mode:0o600});
 fs.renameSync(tmp,DB_FILE);
}

ensureStarterCatalog();

const BACKUP_RETENTION = Math.max(3, Number(process.env.BACKUP_RETENTION || 14));
const BACKUP_INTERVAL_MS = Math.max(6 * 60 * 60 * 1000, Number(process.env.BACKUP_INTERVAL_MS || 24 * 60 * 60 * 1000));
function backupChecksum(payload){return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')}
function verifyAutomaticBackupFile(filePath){
  try{
    const payload=JSON.parse(fs.readFileSync(filePath,'utf8'));
    if(payload.format!=='rajmukhi-education-backup-v2'||!payload.database)return {ok:false,error:'Invalid backup format'};
    const {checksum,...withoutChecksum}=payload;
    const expected=backupChecksum(withoutChecksum);
    return {ok:checksum===expected,file:path.basename(filePath),checksum:checksum||null,expected_checksum:expected,created_at:payload.created_at||null};
  }catch(e){return {ok:false,file:path.basename(filePath),error:String(e.message||e)}}
}
function verifyBackupSet(){
  let files=[];
  try{files=fs.readdirSync(BACKUP_DIR).filter(n=>n.startsWith('rajmukhi-auto-')&&n.endsWith('.json')).sort().reverse()}catch{}
  const results=files.map(n=>verifyAutomaticBackupFile(path.join(BACKUP_DIR,n)));
  return {total:results.length,valid:results.filter(x=>x.ok).length,invalid:results.filter(x=>!x.ok).length,results};
}
function createAutomaticBackup(){
  try{
    const payload={format:'rajmukhi-education-backup-v2',created_at:new Date().toISOString(),database:db,uploads:fs.existsSync(UPLOAD_DIR)?fs.readdirSync(UPLOAD_DIR).filter(n=>fs.statSync(path.join(UPLOAD_DIR,n)).isFile()).map(name=>{const file=path.join(UPLOAD_DIR,name);return {name,data:fs.readFileSync(file).toString('base64')}}):[]};
    const checksum=backupChecksum(payload);
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    const out=path.join(BACKUP_DIR,`rajmukhi-auto-${stamp}.json`);
    const tmp=out+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify({...payload,checksum},null,2));
    fs.renameSync(tmp,out);
    const files=fs.readdirSync(BACKUP_DIR).filter(n=>n.startsWith('rajmukhi-auto-')&&n.endsWith('.json')).sort().reverse();
    for(const old of files.slice(BACKUP_RETENTION))try{fs.unlinkSync(path.join(BACKUP_DIR,old))}catch{}
    return {file:path.basename(out),checksum,retained:Math.min(files.length,BACKUP_RETENTION)};
  }catch(e){return {error:String(e.message||e)}}
}
function id(){return crypto.randomUUID()}
function normalizeQuestionAnswer(q){
 const opts=Array.isArray(q&&q.options)?q.options:[];
 if(q&&q.answer_index!==undefined&&q.answer_index!==null){
   const n=Number(q.answer_index);
   if(Number.isInteger(n)&&n>=0&&n<opts.length)return n;
 }
 const raw=q&&q.answer;
 // Prefer explicit 0-based answer_index. For legacy numeric answers, resolve
 // 1-based values when they are outside the valid 0-based range; otherwise
 // preserve the conventional 0-based index used by the app.
 if(typeof raw==='number'&&Number.isFinite(raw)){
   if(Number.isInteger(raw)&&raw>=0&&raw<opts.length)return raw;
   if(Number.isInteger(raw)&&raw>=1&&raw<=opts.length)return raw-1;
 }
 const s=String(raw??'').trim();
 if(/^\d+$/.test(s)){
   const n=Number(s);
   if(n>=0&&n<opts.length)return n;
   if(n>=1&&n<=opts.length)return n-1;
 }
 if(/^[A-Za-z]$/.test(s)){
   const n=s.toUpperCase().charCodeAt(0)-65;
   return n>=0&&n<opts.length?n:0;
 }
 const i=opts.findIndex(o=>String(o).trim().toLowerCase()===s.toLowerCase());
 return i>=0?i:0;
}
function hash(v){return crypto.createHash('sha256').update(String(v)).digest('hex')}
function certificateHash(c){return hash([c.certificate_no,c.student_name,c.course_title,c.issued_at].join('|')).slice(0,24).toUpperCase()}
function base32Encode(buf){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits=0,value=0,out='';for(const byte of buf){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=alphabet[(value>>>(bits-5))&31];bits-=5}}if(bits>0)out+=alphabet[(value<<(5-bits))&31];return out}
function base32Decode(str){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits=0,value=0,out=[];for(const c of String(str).replace(/=+$/,'').toUpperCase()){const n=alphabet.indexOf(c);if(n<0)continue;value=(value<<5)|n;bits+=5;if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8}}return Buffer.from(out)}
function totp(secret, counter=Math.floor(Date.now()/30000)){const key=base32Decode(secret);const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(counter));const h=crypto.createHmac('sha1',key).update(b).digest();const off=h[h.length-1]&15;const code=((h.readUInt32BE(off)&0x7fffffff)%1000000).toString().padStart(6,'0');return code}
function verifyTotp(secret, code){const c=String(code||'').trim();if(!/^\d{6}$/.test(c))return false;const now=Math.floor(Date.now()/30000);return [now-1,now,now+1].some(x=>totp(secret,x)===c)}
function recoveryCode(){return crypto.randomBytes(5).toString('hex').toUpperCase().match(/.{1,4}/g).join('-')}
function generateRecoveryCodes(){return Array.from({length:10},()=>recoveryCode())}
function deviceIdFrom(req,b={}){return String(b.device_id||req.headers['x-device-id']||'').slice(0,120)||'unknown'}
function addSecurityAlert(user_id,type,details={}){db.security_alerts.push({id:id(),user_id,type,details,created_at:new Date().toISOString(),read:false});if(db.security_alerts.length>1000)db.security_alerts=db.security_alerts.slice(-1000)}

function createSession(u,meta={}){const token=crypto.randomBytes(32).toString('hex');db.sessions.push({token,user_id:u.id,role:u.role,device_id:meta.device_id||'unknown',device_label:meta.device_label||'Unknown device',created_at:new Date().toISOString(),expires_at:new Date(Date.now()+7*86400000).toISOString()});return token}

function send(res,status,data,headers={}){
 const base={'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization, X-Device-ID','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN','Referrer-Policy':'strict-origin-when-cross-origin','Cache-Control':'no-store'};
 if(IS_PRODUCTION)base['Strict-Transport-Security']='max-age=31536000; includeSubDomains';
 res.writeHead(status,{...base,...headers});res.end(JSON.stringify(data))
}
function clientIp(req){return String(req.socket.remoteAddress||'unknown').trim()}
function rateLimited(req,key){
 const now=Date.now(), bucketKey=key+':'+clientIp(req), arr=(rateBuckets.get(bucketKey)||[]).filter(t=>now-t<RATE_WINDOW_MS);
 arr.push(now);rateBuckets.set(bucketKey,arr);
 if(rateBuckets.size>5000){for(const [k,v] of rateBuckets)if(!v.some(t=>now-t<RATE_WINDOW_MS))rateBuckets.delete(k)}
 return arr.length>RATE_LIMIT
}
function requestId(){return crypto.randomBytes(8).toString('hex')}
function cleanupExpiredData(){
 const now=new Date();
 const beforeSessions=db.sessions.length;
 db.sessions=db.sessions.filter(x=>new Date(x.expires_at)>now);
 db.twofa_challenges=db.twofa_challenges.filter(x=>new Date(x.expires_at)>now);
 if(db.sessions.length!==beforeSessions) saveDB();
}
function serveFile(res,filePath,contentType){
 if(!fs.existsSync(filePath))return send(res,404,{error:'Not found'});
 res.writeHead(200,{'Content-Type':contentType,'X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN','Referrer-Policy':'strict-origin-when-cross-origin'});
 return fs.createReadStream(filePath).pipe(res)
}

function parseMultipart(req,body){
 const ct=req.headers['content-type']||''; const m=ct.match(/boundary=(?:"([^"]+)"|([^;]+))/); if(!m)return null;
 const boundary='--'+(m[1]||m[2]); const parts=body.split(boundary).slice(1,-1); const out=[];
 for(const part of parts){let x=part.replace(/^\r\n/,'').replace(/\r\n--$/,'');const idx=x.indexOf('\r\n\r\n');if(idx<0)continue;const head=x.slice(0,idx),data=x.slice(idx+4);const nm=(head.match(/name="([^"]+)"/)||[])[1];const fn=(head.match(/filename="([^"]*)"/)||[])[1];out.push({name:nm,filename:fn,headers:head,data})} return out;
}

function readBody(req){return new Promise((resolve,reject)=>{let b='',tooLarge=false;req.on('data',c=>{if(tooLarge)return;b+=c;if(b.length>10_000_000){tooLarge=true;reject(Object.assign(new Error('request body too large'),{code:'BODY_TOO_LARGE'}));req.destroy()}});req.on('end',()=>{if(tooLarge)return;try{resolve(b?JSON.parse(b):{})}catch{reject(new Error('invalid JSON'))}});req.on('error',err=>{if(!tooLarge)reject(err)})})}
function route(req){const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);return {path:u.pathname,query:u.searchParams}}
function tokenFrom(req){
 const bearer=(req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim();
 if(bearer)return bearer;
 const cookie=String(req.headers.cookie||'');
 const m=cookie.match(/(?:^|;\s*)rde_session=([^;]+)/);
 return m?decodeURIComponent(m[1]):'';
}
function auth(req){const t=tokenFrom(req);return db.sessions.find(s=>s.token===t&&new Date(s.expires_at)>new Date())||null}
function requireAdmin(req,res){const s=auth(req);if(!s||s.role!=='admin'){send(res,401,{error:'admin authentication required'});return null}return s}
function requireUser(req,res){const s=auth(req);if(!s){send(res,401,{error:'authentication required'});return null}return s}
function safeUser(u){return {id:u.id,name:u.name,email:u.email,role:u.role,created_at:u.created_at}}
function seed(){if(!db.courses.length)db.courses=[{id:'course-science',title:'General Science',description:'Physics, Chemistry, Biology और सामान्य विज्ञान',lessons:100,created_at:new Date().toISOString()},{id:'course-math',title:'Mathematics',description:'Basic से Advanced Mathematics',lessons:80,created_at:new Date().toISOString()},{id:'course-reasoning',title:'Reasoning',description:'Verbal और Non-Verbal Reasoning',lessons:65,created_at:new Date().toISOString()}];if(!db.lessons.length)db.lessons=[{id:'lesson-science-1',course_id:'course-science',title:'Introduction to General Science',description:'विज्ञान की मूल अवधारणाएँ',content:'यह lesson विज्ञान की मूल अवधारणाओं से शुरू होता है।',order:1},{id:'lesson-math-1',course_id:'course-math',title:'Number System Basics',description:'संख्या पद्धति की शुरुआत',content:'Natural, whole और integer numbers का परिचय।',order:1}];if(!db.notes.length)db.notes=[{id:'note-science',title:'General Science Notes',description:'Study material',file_url:'',created_at:new Date().toISOString()}];if(!db.notices.length)db.notices=[{id:'notice-welcome',title:'Welcome',message:'Rajmukhi Education में आपका स्वागत है।',created_at:new Date().toISOString()}];if(!db.tests.length)db.tests=[{id:'test-gs-1',title:'General Science Quiz',course_id:'course-science',questions:[{id:1,question:'भारत की राजधानी क्या है?',options:['पटना','नई दिल्ली','मुंबई'],answer:1},{id:2,question:'पानी का रासायनिक सूत्र क्या है?',options:['H₂O','CO₂','O₂'],answer:0}],created_at:new Date().toISOString()}];saveDB()}
seed();
const server=http.createServer(async(req,res)=>{
 const rid=requestId();
 res.setHeader('X-Request-ID',rid);
 req.setTimeout(REQUEST_TIMEOUT_MS,()=>{if(!res.headersSent){send(res,408,{error:'request timeout',request_id:rid})}req.destroy()});
if(req.method==='OPTIONS')return send(res,204,{});const {path:p,query}=route(req);
if(req.method==='GET'&&p==='/api/health')return send(res,200,{ok:true,app:'Rajmukhi Education',version:APP_VERSION,database:'persistent-json',features:['auth','uploads','student-dashboard','certificate-generation','certificate-verification','professional-certificate','student-profile','account-security','totp-2fa','otp-login-challenge','trusted-devices','recovery-codes','security-alerts-v35','session-revoke-per-device','session-labeling','personal-data-export','security-center-v36','privacy-controls-v37','admin-security-audit-v38','audit-filtering','audit-export','privacy-aware-public-profile','shareable-profile','achievements','final-release']});
if(req.method==='GET'&&p==='/api/ready'){
 let dbWritable=false, uploadsWritable=false;
 try{fs.accessSync(path.dirname(DB_FILE),fs.constants.W_OK);dbWritable=true}catch{}
 try{fs.accessSync(UPLOAD_DIR,fs.constants.W_OK);uploadsWritable=true}catch{}
 const checks={
   database:Array.isArray(db.users)&&Array.isArray(db.courses)&&Array.isArray(db.lessons),
   db_directory_writable:dbWritable,
   uploads:fs.existsSync(UPLOAD_DIR),
   uploads_writable:uploadsWritable
 };
 const ready=Object.values(checks).every(Boolean);
 return send(res,ready?200:503,{ok:ready,app:'Rajmukhi Education',version:APP_VERSION,checks});
}
if(req.method==='GET'&&p==='/api/admin/backups/verify'){if(!requireAdmin(req,res))return;return send(res,200,{ok:true,...verifyBackupSet()});}
if(req.method==='GET'&&p==='/api/version')return send(res,200,{app:'Rajmukhi Education',version:APP_VERSION,node:process.version,environment:process.env.NODE_ENV||'development'});
if(req.method==='GET'&&p==='/api/admin/diagnostics'){
 if(!requireAdmin(req,res))return;
 let dbBytes=0;
 try{dbBytes=fs.statSync(DB_FILE).size}catch{}
 let backupCount=0,lastBackup=null;
 try{const files=fs.readdirSync(BACKUP_DIR).filter(x=>x.endsWith('.json'));backupCount=files.length;lastBackup=files.sort().slice(-1)[0]||null}catch{}
 return send(res,200,{ok:true,version:APP_VERSION,uptime_seconds:Math.round(process.uptime()),memory:process.memoryUsage(),database:{file:DB_FILE,size_bytes:dbBytes,counts:Object.fromEntries(Object.entries(db).map(([k,v])=>[k,Array.isArray(v)?v.length:0]))},uploads:{directory:UPLOAD_DIR,count:db.uploads.length},backups:{directory:BACKUP_DIR,count:backupCount,last_backup:lastBackup,integrity:verifyBackupSet()}});
}
if(req.method==='GET'&&p==='/api/stats')return send(res,200,{students:db.students.length,courses:db.courses.length,notes:db.notes.length,tests:db.tests.length,testAttempts:db.results.length,users:db.users.length});
if(req.method==='POST'&&p==='/api/auth/register'){if(rateLimited(req,'register'))return send(res,429,{error:'too many registration attempts; try again later'});try{const b=await readBody(req);if(!b.name||!b.email||!b.password)return send(res,400,{error:'name, email and password are required'});if(db.users.some(u=>u.email.toLowerCase()===String(b.email).toLowerCase()))return send(res,409,{error:'email already registered'});const u={id:id(),name:String(b.name).trim(),email:String(b.email).trim(),password_hash:hash(b.password),role:'student',created_at:new Date().toISOString()};db.users.push(u);db.students.push({id:u.id,name:u.name,email:u.email,created_at:u.created_at});const token=crypto.randomBytes(32).toString('hex');db.sessions.push({token,user_id:u.id,role:u.role,created_at:new Date().toISOString(),expires_at:new Date(Date.now()+7*86400000).toISOString()});saveDB();res.setHeader('Set-Cookie',`rde_session=${encodeURIComponent(token)}; Path=/; Max-Age=${7*86400}; HttpOnly; SameSite=Lax`);return send(res,201,{token,user:safeUser(u)})}catch{return send(res,400,{error:'invalid JSON'})}}
if(req.method==='POST'&&p==='/api/auth/login'){if(rateLimited(req,'login'))return send(res,429,{error:'too many login attempts; try again later'});try{const b=await readBody(req);let u;if(String(b.email).toLowerCase()===ADMIN_EMAIL.toLowerCase()&&String(b.password)===ADMIN_PASSWORD){u={id:'admin',name:'Rajmukhi Admin',email:ADMIN_EMAIL,role:'admin'}}else{u=db.users.find(x=>x.email.toLowerCase()===String(b.email||'').toLowerCase()&&x.password_hash===hash(b.password||''));if(!u)return send(res,401,{error:'invalid credentials'})}if(u.two_factor_enabled&&u.two_factor_secret){const challenge=crypto.randomBytes(32).toString('hex');db.twofa_challenges.push({challenge,user_id:u.id,created_at:new Date().toISOString(),expires_at:new Date(Date.now()+5*60000).toISOString()});db.security_events.push({id:id(),user_id:u.id,type:'2fa_login_challenge',created_at:new Date().toISOString()});saveDB();return send(res,202,{requires_2fa:true,challenge,message:'Enter the 6-digit authenticator code to continue'})}const token=createSession(u,{device_id:deviceIdFrom(req,b),device_label:b.device_label||'Web browser'});addSecurityAlert(u.id,'new_login',{device_label:b.device_label||'Web browser'});saveDB();res.setHeader('Set-Cookie',`rde_session=${encodeURIComponent(token)}; Path=/; Max-Age=${7*86400}; HttpOnly; SameSite=Lax`);return send(res,200,{token,user:safeUser(u)})}catch{return send(res,400,{error:'invalid JSON'})}}
if(req.method==='POST'&&p==='/api/auth/2fa/verify'){if(rateLimited(req,'2fa'))return send(res,429,{error:'too many 2FA attempts; try again later'});try{const b=await readBody(req);const c=db.twofa_challenges.find(x=>x.challenge===b.challenge&&new Date(x.expires_at)>new Date());if(!c)return send(res,401,{error:'invalid or expired 2FA challenge'});const u=db.users.find(x=>x.id===c.user_id);if(!u||!u.two_factor_secret)return send(res,401,{error:'invalid authenticator code'});
let usedRecovery=false;
if(!verifyTotp(u.two_factor_secret,b.code)){
 const rc=String(b.code||'').trim().toUpperCase();
 const idx=(u.recovery_codes||[]).findIndex(x=>x===rc);
 if(idx<0)return send(res,401,{error:'invalid authenticator or recovery code'});
 u.recovery_codes.splice(idx,1); usedRecovery=true;
}db.twofa_challenges=db.twofa_challenges.filter(x=>x.challenge!==c.challenge);const token=createSession(u,{device_id:deviceIdFrom(req,b),device_label:b.device_label||'Web browser'});db.security_events.push({id:id(),user_id:u.id,type:usedRecovery?'recovery_code_login':'2fa_login_verified',created_at:new Date().toISOString()});addSecurityAlert(u.id,'new_login',{device_label:b.device_label||'Web browser',two_factor:true});saveDB();return send(res,200,{token,user:safeUser(u)})}catch{return send(res,400,{error:'invalid JSON'})}}
if(req.method==='POST'&&p==='/api/auth/refresh'){
 const current=auth(req);
 if(!current)return send(res,401,{error:'authentication required'});
 const u=current.role==='admin'?{id:'admin',name:'Rajmukhi Admin',email:ADMIN_EMAIL,role:'admin'}:db.users.find(x=>x.id===current.user_id);
 if(!u)return send(res,401,{error:'user not found'});
 db.sessions=db.sessions.filter(x=>x.token!==current.token);
 const token=createSession(u,{device_id:current.device_id,device_label:current.device_label});
 saveDB();
 res.setHeader('Set-Cookie',`rde_session=${encodeURIComponent(token)}; Path=/; Max-Age=${7*86400}; HttpOnly; SameSite=Lax`);
 return send(res,200,{token,user:safeUser(u)});
}
if(req.method==='GET'&&p==='/api/auth/me'){const s=auth(req);if(!s)return send(res,401,{error:'not authenticated'});const u=s.role==='admin'?{id:'admin',name:'Rajmukhi Admin',email:ADMIN_EMAIL,role:'admin'}:db.users.find(x=>x.id===s.user_id);return send(res,200,{user:safeUser(u)})}
if(req.method==='POST'&&p==='/api/auth/logout'){const s=auth(req);if(s){db.sessions=db.sessions.filter(x=>x.token!==s.token);saveDB()}res.setHeader('Set-Cookie','rde_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');return send(res,200,{ok:true})}
if(req.method==='GET'&&p==='/api/courses')return send(res,200,db.courses.map(c=>({...c,lessons:db.lessons.filter(l=>l.course_id===c.id).length})));
if(req.method==='GET'&&p==='/api/lessons'){const cid=query.get('course_id');return send(res,200,cid?db.lessons.filter(x=>x.course_id===cid):db.lessons)}
if(req.method==='POST'&&p==='/api/lessons'){const a=requireAdmin(req,res);if(!a)return;const b=await readBody(req);if(!b.course_id||!b.title)return send(res,400,{error:'course_id and title are required'});const x={id:id(),course_id:b.course_id,title:b.title,description:b.description||'',content:b.content||'',order:Number(b.order||1)};db.lessons.push(x);saveDB();return send(res,201,x)}
if(req.method==='PUT'&&p.startsWith('/api/lessons/')){const a=requireAdmin(req,res);if(!a)return;const x=db.lessons.find(x=>x.id===p.split('/').pop());if(!x)return send(res,404,{error:'Lesson not found'});const b=await readBody(req);Object.assign(x,b);saveDB();return send(res,200,x)}
if(req.method==='DELETE'&&p.startsWith('/api/lessons/')){const a=requireAdmin(req,res);if(!a)return;const idx=db.lessons.findIndex(x=>x.id===p.split('/').pop());if(idx<0)return send(res,404,{error:'Lesson not found'});db.lessons.splice(idx,1);saveDB();return send(res,200,{ok:true})}

if(req.method==='GET'&&p==='/api/enrollments'){const s=requireUser(req,res);if(!s)return;return send(res,200,db.enrollments.filter(x=>x.user_id===s.user_id))}
if(req.method==='POST'&&p==='/api/enrollments'){const s=requireUser(req,res);if(!s)return;const b=await readBody(req);if(!b.course_id)return send(res,400,{error:'course_id is required'});if(!db.enrollments.some(x=>x.user_id===s.user_id&&x.course_id===b.course_id)){const x={id:id(),user_id:s.user_id,course_id:b.course_id,created_at:new Date().toISOString()};db.enrollments.push(x);saveDB();return send(res,201,x)}return send(res,200,{ok:true,alreadyEnrolled:true})}
if(req.method==='GET'&&p==='/api/progress'){const s=requireUser(req,res);if(!s)return;return send(res,200,db.progress.filter(x=>x.user_id===s.user_id))}
if(req.method==='POST'&&p==='/api/progress'){const s=requireUser(req,res);if(!s)return;try{const b=await readBody(req);const courseId=String(b.course_id||'');const lessonId=String(b.lesson_id||'');if(!courseId||!lessonId)return send(res,400,{error:'course_id and lesson_id are required'});const lesson=db.lessons.find(l=>String(l.id)===lessonId&&String(l.course_id)===courseId);if(!lesson)return send(res,404,{error:'lesson not found for this course'});const course=db.courses.find(c=>String(c.id)===courseId);if(!course)return send(res,404,{error:'course not found'});if(!db.enrollments.some(e=>e.user_id===s.user_id&&String(e.course_id)===courseId)){db.enrollments.push({id:id(),user_id:s.user_id,course_id:courseId,created_at:new Date().toISOString()});}let x=db.progress.find(x=>x.user_id===s.user_id&&String(x.lesson_id)===lessonId);if(x){x.course_id=courseId;x.completed=!!b.completed}else{x={id:id(),user_id:s.user_id,course_id:courseId,lesson_id:lessonId,completed:!!b.completed,updated_at:new Date().toISOString()};db.progress.push(x)}x.updated_at=new Date().toISOString();saveDB();return send(res,200,{ok:true,...x})}catch{return send(res,400,{error:'invalid progress data'})}}

if(req.method==='GET'&&p==='/api/notes')return send(res,200,db.notes);
if(req.method==='GET'&&p==='/api/notices')return send(res,200,db.notices);
if(req.method==='GET'&&p==='/api/videos')return send(res,200,db.videos);
if(req.method==='GET'&&p==='/api/tests')return send(res,200,db.tests.map(t=>({id:t.id,title:t.title,course_id:t.course_id,questionCount:t.questions.length,created_at:t.created_at})));
if(req.method==='GET'&&p.startsWith('/api/tests/')){
 const s=requireUser(req,res); if(!s)return;
 const t=db.tests.find(x=>x.id===p.split('/').pop());
 if(!t)return send(res,404,{error:'Test not found'});
 const safe={...t,questions:t.questions.map(q=>({id:q.id,question:q.question,options:q.options}))};
 return send(res,200,safe);
}
if(req.method==='POST'&&p==='/api/results'){
 const s=requireUser(req,res);if(!s)return;
 try{
  const b=await readBody(req);
  if(!b.test_id)return send(res,400,{error:'test_id is required'});
  const t=db.tests.find(x=>x.id===String(b.test_id));
  if(!t)return send(res,404,{error:'test not found'});
  const answers=Array.isArray(b.answers)?b.answers:[];
  const score=t.questions.reduce((sum,q,i)=>sum+(Number(answers[i])===normalizeQuestionAnswer(q)?1:0),0);
  const total=t.questions.length;
  const r={id:id(),student_id:s.user_id,test_id:t.id,score,total,answers:answers.map(x=>Number.isFinite(Number(x))?Number(x):null),created_at:new Date().toISOString()};
  db.results.push(r);saveDB();return send(res,201,r);
 }catch{return send(res,400,{error:'invalid JSON'})}
}
if(req.method==='GET'&&p==='/api/results'){const s=requireUser(req,res);if(!s)return;const all=s.role==='admin'?db.results:db.results.filter(r=>String(r.student_id||r.user_id)===String(s.user_id));return send(res,200,all)}
if(req.method==='GET'&&p==='/api/students'){if(!requireAdmin(req,res))return;return send(res,200,db.students)}
if(req.method==='GET'&&p.startsWith('/api/admin/students/')){if(!requireAdmin(req,res))return;const sid=p.split('/').pop();const u=db.users.find(x=>x.id===sid)||db.students.find(x=>x.id===sid);if(!u)return send(res,404,{error:'Student not found'});const results=db.results.filter(x=>x.student_id===sid);const progress=db.progress.filter(x=>x.user_id===sid);return send(res,200,{student:safeUser(u),results,progress,enrollments:db.enrollments.filter(x=>x.user_id===sid)})}
if(req.method==='GET'&&p==='/api/admin/results'){if(!requireAdmin(req,res))return;return send(res,200,db.results)}
if(req.method==='GET'&&p==='/api/admin/analytics'){if(!requireAdmin(req,res))return;const now=Date.now();const activeStudents30d=new Set(db.results.filter(x=>now-new Date(x.created_at).getTime()<=30*86400000).map(x=>x.student_id)).size;const averageScore=db.results.length?Math.round(db.results.reduce((sum,x)=>sum+(x.score/(x.total||1))*100,0)/db.results.length)+'%':'0%';const courseStats=db.courses.map(c=>({id:c.id,title:c.title,enrollments:db.enrollments.filter(e=>e.course_id===c.id).length,lessons:db.lessons.filter(l=>l.course_id===c.id).length}));return send(res,200,{enrollments:db.enrollments.length,activeStudents30d,averageScore,courseStats})}
if(req.method==='POST'&&p.match(/^\/api\/admin\/students\/[^/]+\/enrollments$/)){if(!requireAdmin(req,res))return;const sid=p.split('/')[4];const b=await readBody(req);if(!b.course_id)return send(res,400,{error:'course_id is required'});if(!db.students.some(x=>x.id===sid)&&!db.users.some(x=>x.id===sid))return send(res,404,{error:'student not found'});if(!db.courses.some(x=>x.id===b.course_id))return send(res,404,{error:'course not found'});if(db.enrollments.some(x=>x.user_id===sid&&x.course_id===b.course_id))return send(res,200,{ok:true,alreadyEnrolled:true});const x={id:id(),user_id:sid,course_id:String(b.course_id),created_at:new Date().toISOString()};db.enrollments.push(x);saveDB();return send(res,201,x)}
if(req.method==='DELETE'&&p.match(/^\/api\/admin\/students\/[^/]+\/enrollments\/[^/]+$/)){if(!requireAdmin(req,res))return;const parts=p.split('/');const sid=parts[4],cid=parts[6];const before=db.enrollments.length;db.enrollments=db.enrollments.filter(x=>!(x.user_id===sid&&x.course_id===cid));if(before===db.enrollments.length)return send(res,404,{error:'enrollment not found'});saveDB();return send(res,200,{ok:true})}

if(req.method==='GET'&&p==='/api/admin/courses'){if(!requireAdmin(req,res))return;return send(res,200,db.courses)}
if(req.method==='GET'&&p==='/api/admin/lessons'){if(!requireAdmin(req,res))return;return send(res,200,db.lessons)}
if(req.method==='POST'&&p==='/api/admin/courses'){if(!requireAdmin(req,res))return;const b=await readBody(req);if(!b.title)return send(res,400,{error:'title is required'});const x={id:id(),title:String(b.title),description:b.description||'',lessons:Number(b.lessons||0),created_at:new Date().toISOString()};db.courses.push(x);saveDB();return send(res,201,x)}
if(req.method==='PUT'&&p.startsWith('/api/admin/courses/')){if(!requireAdmin(req,res))return;const x=db.courses.find(x=>x.id===p.split('/').pop());if(!x)return send(res,404,{error:'course not found'});const b=await readBody(req);if(b.title!==undefined)x.title=String(b.title);if(b.description!==undefined)x.description=String(b.description);if(b.lessons!==undefined)x.lessons=Number(b.lessons||0);saveDB();return send(res,200,x)}

if(req.method==='POST'&&p==='/api/admin/lessons'){if(!requireAdmin(req,res))return;const b=await readBody(req);if(!b.course_id||!b.title)return send(res,400,{error:'course_id and title are required'});if(!db.courses.some(c=>c.id===String(b.course_id)))return send(res,404,{error:'course not found'});const x={id:id(),course_id:String(b.course_id),title:String(b.title),description:String(b.description||''),content:String(b.content||''),order:Number(b.order||db.lessons.filter(l=>l.course_id===String(b.course_id)).length+1),created_at:new Date().toISOString()};db.lessons.push(x);const c=db.courses.find(c=>c.id===x.course_id);if(c)c.lessons=db.lessons.filter(l=>l.course_id===x.course_id).length;saveDB();return send(res,201,x)}
if(req.method==='PUT'&&p.startsWith('/api/admin/lessons/')){if(!requireAdmin(req,res))return;const x=db.lessons.find(x=>x.id===p.split('/').pop());if(!x)return send(res,404,{error:'lesson not found'});const b=await readBody(req);if(b.course_id!==undefined){if(!db.courses.some(c=>c.id===String(b.course_id)))return send(res,404,{error:'course not found'});x.course_id=String(b.course_id)}if(b.title!==undefined)x.title=String(b.title);if(b.description!==undefined)x.description=String(b.description);if(b.content!==undefined)x.content=String(b.content);if(b.order!==undefined)x.order=Number(b.order||0);saveDB();return send(res,200,x)}
if(req.method==='DELETE'&&p.startsWith('/api/admin/lessons/')){if(!requireAdmin(req,res))return;const lid=p.split('/').pop();const before=db.lessons.length;const lesson=db.lessons.find(x=>x.id===lid);db.lessons=db.lessons.filter(x=>x.id!==lid);if(before===db.lessons.length)return send(res,404,{error:'lesson not found'});if(lesson){const c=db.courses.find(c=>c.id===lesson.course_id);if(c)c.lessons=db.lessons.filter(l=>l.course_id===lesson.course_id).length}db.progress=db.progress.filter(x=>x.lesson_id!==lid);saveDB();return send(res,200,{ok:true})}
if(req.method==='PUT'&&p.startsWith('/api/admin/notes/')){if(!requireAdmin(req,res))return;const x=db.notes.find(x=>x.id===p.split('/').pop());if(!x)return send(res,404,{error:'note not found'});const b=await readBody(req);for(const k of ['title','description','content','file_url'])if(b[k]!==undefined)x[k]=String(b[k]||'');saveDB();return send(res,200,x)}
if(req.method==='PUT'&&p.startsWith('/api/admin/videos/')){if(!requireAdmin(req,res))return;const x=db.videos.find(x=>x.id===p.split('/').pop());if(!x)return send(res,404,{error:'video not found'});const b=await readBody(req);for(const k of ['title','description','url','thumbnail'])if(b[k]!==undefined)x[k]=String(b[k]||'');saveDB();return send(res,200,x)}
if(req.method==='PUT'&&p.startsWith('/api/admin/notices/')){if(!requireAdmin(req,res))return;const x=db.notices.find(x=>x.id===p.split('/').pop());if(!x)return send(res,404,{error:'notice not found'});const b=await readBody(req);if(b.title!==undefined)x.title=String(b.title);if(b.message!==undefined)x.message=String(b.message);saveDB();return send(res,200,x)}
if(req.method==='GET'&&p==='/api/admin/export'){if(!requireAdmin(req,res))return;return send(res,200,{exported_at:new Date().toISOString(),courses:db.courses,lessons:db.lessons,notes:db.notes,notices:db.notices,videos:db.videos,tests:db.tests,students:db.students,enrollments:db.enrollments,progress:db.progress,results:db.results,certificates:db.certificates,uploads:db.uploads})}
if(req.method==='PUT'&&p.startsWith('/api/admin/tests/')){if(!requireAdmin(req,res))return;const x=db.tests.find(x=>x.id===p.split('/').pop());if(!x)return send(res,404,{error:'test not found'});const b=await readBody(req);if(b.title!==undefined)x.title=String(b.title);if(b.course_id!==undefined)x.course_id=String(b.course_id);if(Array.isArray(b.questions))x.questions=b.questions.map((q,i)=>({id:i+1,question:String(q.question||''),options:Array.isArray(q.options)?q.options.map(String):[],answer:normalizeQuestionAnswer(q)}));saveDB();return send(res,200,x)}
if(req.method==='POST'&&p==='/api/admin/notes'){if(!requireAdmin(req,res))return;const b=await readBody(req);if(!b.title)return send(res,400,{error:'title is required'});const x={id:id(),title:String(b.title),description:b.description||'',content:b.content||'',file_url:b.file_url||'',created_at:new Date().toISOString()};db.notes.push(x);saveDB();return send(res,201,x)}
if(req.method==='POST'&&p==='/api/admin/videos'){if(!requireAdmin(req,res))return;const b=await readBody(req);if(!b.title||!b.url)return send(res,400,{error:'title and url are required'});const x={id:id(),title:String(b.title),description:b.description||'',url:String(b.url),thumbnail:b.thumbnail||'',created_at:new Date().toISOString()};db.videos.unshift(x);saveDB();return send(res,201,x)}
if(req.method==='POST'&&p==='/api/admin/notices'){if(!requireAdmin(req,res))return;const b=await readBody(req);if(!b.title||!b.message)return send(res,400,{error:'title and message are required'});const x={id:id(),title:String(b.title),message:String(b.message),created_at:new Date().toISOString()};db.notices.unshift(x);saveDB();return send(res,201,x)}
if(req.method==='POST'&&p==='/api/admin/tests'){if(!requireAdmin(req,res))return;const b=await readBody(req);if(!b.title||!Array.isArray(b.questions)||!b.questions.length)return send(res,400,{error:'title and questions are required'});const qs=b.questions.map((q,i)=>{const options=Array.isArray(q.options)?q.options.map(String):[];const answer_index=normalizeQuestionAnswer(q);return {id:i+1,question:String(q.question),options,answer_index,answer:answer_index};});const x={id:id(),title:String(b.title),course_id:b.course_id||'',questions:qs,created_at:new Date().toISOString()};db.tests.push(x);saveDB();return send(res,201,x)}

if(req.method==='GET'&&p.match(/^\/api\/certificates\/verify\/[^/]+$/)){const cert=db.certificates.find(x=>x.certificate_no===decodeURIComponent(p.split('/').pop()));if(!cert)return send(res,404,{valid:false,error:'certificate not found'});const valid=cert.status!=='revoked';return send(res,200,{valid,certificate:{certificate_no:cert.certificate_no,student_name:cert.student_name,course_title:cert.course_title,issued_at:cert.issued_at,course_id:cert.course_id,verification_hash:cert.verification_hash,status:cert.status||'active'}})}
if(req.method==='GET'&&p==='/api/certificates'){const s=requireUser(req,res);if(!s)return;return send(res,200,db.certificates.filter(x=>x.user_id===s.user_id))}
if(req.method==='POST'&&p==='/api/certificates/generate'){const s=requireUser(req,res);if(!s)return;const b=await readBody(req);const c=db.courses.find(x=>x.id===b.course_id);if(!c)return send(res,404,{error:'course not found'});const enrolled=db.enrollments.some(x=>x.user_id===s.user_id&&x.course_id===c.id);if(!enrolled)return send(res,403,{error:'course enrollment required'});const lessons=db.lessons.filter(x=>x.course_id===c.id);const done=db.progress.filter(x=>x.user_id===s.user_id&&x.course_id===c.id&&x.completed).length;if(!lessons.length||done<lessons.length)return send(res,403,{error:'complete all course lessons first'});const existing=db.certificates.find(x=>x.user_id===s.user_id&&x.course_id===c.id);if(existing)return send(res,200,existing);const u=db.users.find(x=>x.id===s.user_id);const cert={id:id(),certificate_no:'RDE-'+new Date().getFullYear()+'-'+crypto.randomBytes(4).toString('hex').toUpperCase(),user_id:s.user_id,student_name:u?.name||'Student',course_id:c.id,course_title:c.title,issued_at:new Date().toISOString()};cert.verification_hash=certificateHash(cert);cert.status='active';db.certificates.push(cert);saveDB();return send(res,201,cert)}
if(req.method==='GET'&&p.match(/^\/api\/certificates\/[^/]+\/download$/)){const s=requireUser(req,res);if(!s)return;const cert=db.certificates.find(x=>x.certificate_no===decodeURIComponent(p.split('/')[3])&&x.user_id===s.user_id);if(!cert)return send(res,404,{error:'certificate not found'});const verifyUrl=`/certificate/${encodeURIComponent(cert.certificate_no)}`;return send(res,200,{certificate_no:cert.certificate_no,download_type:'print-ready-html',verify_url:verifyUrl,filename:`${cert.certificate_no}.html`})}
if(req.method==='PUT'&&p==='/api/profile/student'){const s=requireUser(req,res);if(!s)return;const b=await readBody(req);const u=db.users.find(x=>x.id===s.user_id);if(!u)return send(res,404,{error:'user not found'});if(b.name!==undefined){const name=String(b.name).trim();if(name.length<2)return send(res,400,{error:'name must be at least 2 characters'});u.name=name;const st=db.students.find(x=>x.id===s.user_id);if(st)st.name=name}if(b.email!==undefined){const email=String(b.email).trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return send(res,400,{error:'invalid email'});if(db.users.some(x=>x.id!==u.id&&x.email.toLowerCase()===email))return send(res,409,{error:'email already registered'});u.email=email;const st=db.students.find(x=>x.id===s.user_id);if(st)st.email=email}saveDB();return send(res,200,{user:safeUser(u)})}
if(req.method==='GET'&&p.match(/^\/api\/profile\/student$/)){const s=requireUser(req,res);if(!s)return;const u=db.users.find(x=>x.id===s.user_id)||{};const enrollments=db.enrollments.filter(x=>x.user_id===s.user_id);const results=db.results.filter(x=>x.student_id===s.user_id);const certificates=db.certificates.filter(x=>x.user_id===s.user_id);return send(res,200,{user:safeUser(u),enrollments:enrollments.map(e=>{const c=db.courses.find(x=>x.id===e.course_id)||{};return {course_id:e.course_id,title:c.title||'Course',enrolled_at:e.created_at}}),results,certificates})}
if(req.method==='GET'&&p.match(/^\/api\/certificates\/[^/]+\/html$/)){const s=requireUser(req,res);if(!s)return;const cert=db.certificates.find(x=>x.certificate_no===decodeURIComponent(p.split('/')[3])&&x.user_id===s.user_id);if(!cert)return send(res,404,{error:'certificate not found'});const escHtml=v=>String(v??'').replace(/[&<>\"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[m]));const verifyUrl=`/certificate/${encodeURIComponent(cert.certificate_no)}`;const html='<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Certificate '+escHtml(cert.certificate_no)+'</title><style>@page{size:A4 landscape;margin:0}*{box-sizing:border-box}body{margin:0;background:#eef2f7;font-family:Georgia,serif;color:#172033}.sheet{width:297mm;min-height:210mm;margin:20px auto;background:#fff;position:relative;padding:18mm;border:8px solid #172b4d;box-shadow:0 10px 40px #0002;overflow:hidden}.sheet:before{content:\"\";position:absolute;inset:8mm;border:2px solid #b8954b;pointer-events:none}.inner{position:relative;text-align:center;padding:12mm 18mm}.brand{font:700 20px Arial,sans-serif;letter-spacing:3px;color:#172b4d;text-transform:uppercase}.title{font-size:44px;letter-spacing:2px;margin:18px 0 8px;color:#172b4d}.subtitle{font:16px Arial,sans-serif;color:#667085}.name{font-size:42px;font-weight:700;margin:20px 0 10px;color:#111827}.course{font-size:28px;font-weight:700;color:#8a6427;margin:12px 0}.body{font:16px Arial,sans-serif;color:#475467}.meta{display:flex;justify-content:space-between;gap:20px;margin-top:38px;font:12px Arial,sans-serif;text-align:left}.meta b{display:block;color:#172b4d;margin-bottom:5px}.verify{position:absolute;right:20mm;bottom:14mm;width:34mm;height:34mm;border:2px solid #172b4d;border-radius:8px;display:flex;align-items:center;justify-content:center;text-align:center;font:700 9px Arial,sans-serif;color:#172b4d}.print{position:fixed;top:16px;right:16px;padding:10px 16px;background:#172b4d;color:white;border:0;border-radius:8px;cursor:pointer}@media print{body{background:#fff}.sheet{margin:0;box-shadow:none}.print{display:none}}</style></head><body><button class=\"print\" onclick=\"window.print()\">Print / Save as PDF</button><main class=\"sheet\"><section class=\"inner\"><div class=\"brand\">Rajmukhi Education</div><div class=\"title\">Certificate of Completion</div><div class=\"subtitle\">This certificate is proudly presented to</div><div class=\"name\">'+escHtml(cert.student_name)+'</div><div class=\"body\">for successfully completing the course</div><div class=\"course\">'+escHtml(cert.course_title)+'</div><div class=\"body\">and fulfilling the required learning milestones.</div><div class=\"meta\"><div><b>Certificate No.</b>'+escHtml(cert.certificate_no)+'</div><div><b>Issued On</b>'+escHtml(new Date(cert.issued_at).toLocaleDateString('en-IN'))+'</div><div><b>Verification Hash</b>'+escHtml(cert.verification_hash||certificateHash(cert))+'</div></div></section><div class=\"verify\">VERIFY<br>ONLINE<br>'+escHtml(cert.certificate_no)+'</div></main></body></html>';res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Disposition':'inline'});return res.end(html)}
if(req.method==='GET'&&p==='/api/admin/certificates'){if(!requireAdmin(req,res))return;const q=String(query.get('q')||'').toLowerCase();const list=db.certificates.filter(c=>!q||[c.certificate_no,c.student_name,c.course_title].some(v=>String(v||'').toLowerCase().includes(q))).sort((a,b)=>new Date(b.issued_at)-new Date(a.issued_at));return send(res,200,list)}
if(req.method==='POST'&&p.match(/^\/api\/admin\/certificates\/[^/]+\/revoke$/)){if(!requireAdmin(req,res))return;const cert=db.certificates.find(x=>x.certificate_no===decodeURIComponent(p.split('/')[4]));if(!cert)return send(res,404,{error:'certificate not found'});const b=await readBody(req);cert.status='revoked';cert.revoked_at=new Date().toISOString();cert.revocation_reason=String(b.reason||'Revoked by administrator');saveDB();return send(res,200,cert)}
if(req.method==='GET'&&p.match(/^\/certificate\/[^/]+$/)){const cert=db.certificates.find(x=>x.certificate_no===decodeURIComponent(p.split('/').pop()));if(!cert)return send(res,404,{error:'certificate not found'});const valid=cert.status!=='revoked';const esc=v=>String(v??'').replace(/[&<>\"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[m]));const html='<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Certificate Verification</title><style>body{font-family:Arial,sans-serif;background:#f5f7fb;padding:24px}.card{max-width:720px;margin:40px auto;background:#fff;border-radius:18px;padding:32px;box-shadow:0 8px 30px #0001}.ok{color:#16803c}.bad{color:#b42318}.row{padding:12px 0;border-bottom:1px solid #eee}.label{color:#667085;font-size:12px;text-transform:uppercase}.value{font-size:18px;margin-top:4px}</style></head><body><div class=\"card\"><h1>Certificate Verification</h1><h2 class=\"'+(valid?'ok':'bad')+'\">'+(valid?'✓ Valid Certificate':'✕ Revoked Certificate')+'</h2><div class=\"row\"><div class=\"label\">Certificate No.</div><div class=\"value\">'+esc(cert.certificate_no)+'</div></div><div class=\"row\"><div class=\"label\">Student</div><div class=\"value\">'+esc(cert.student_name)+'</div></div><div class=\"row\"><div class=\"label\">Course</div><div class=\"value\">'+esc(cert.course_title)+'</div></div><div class=\"row\"><div class=\"label\">Issued</div><div class=\"value\">'+esc(new Date(cert.issued_at).toLocaleDateString('en-IN'))+'</div></div><div class=\"row\"><div class=\"label\">Verification Hash</div><div class=\"value\">'+esc(cert.verification_hash||certificateHash(cert))+'</div></div></div></body></html>';res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(html)}
if(req.method==='GET'&&p==='/api/dashboard/student'){const s=requireUser(req,res);if(!s)return;const enrolled=db.enrollments.filter(x=>x.user_id===s.user_id);const progress=db.progress.filter(x=>x.user_id===s.user_id);const results=db.results.filter(x=>String(x.student_id||x.user_id)===String(s.user_id));const courseSummary=enrolled.map(e=>{const c=db.courses.find(x=>x.id===e.course_id)||{};const lessons=db.lessons.filter(x=>x.course_id===e.course_id).sort((a,b)=>(a.order||0)-(b.order||0));const done=progress.filter(x=>x.course_id===e.course_id&&x.completed).length;const next=lessons.find(l=>!progress.some(x=>x.lesson_id===l.id&&x.completed));return {course_id:e.course_id,title:c.title||'Course',completed:done,total:lessons.length,percent:lessons.length?Math.round(done/lessons.length*100):0,nextLesson:next?{id:next.id,title:next.title}:null}});const completedLessonIds=new Set(progress.filter(x=>x.completed&&x.lesson_id!=null).map(x=>String(x.lesson_id)));const completedLessons=completedLessonIds.size;const validResults=results.filter(r=>Number.isFinite(Number(r.score))&&Number(r.total)>0);const avgScore=validResults.length?Math.round(validResults.reduce((n,r)=>n+(100*Number(r.score)/Number(r.total)),0)/validResults.length):0;const activityDates=new Set();for(const r of validResults){const d=new Date(r.created_at);if(!Number.isNaN(d.getTime()))activityDates.add(d.toISOString().slice(0,10));}for(const p of progress.filter(x=>x.completed)){const d=new Date(p.updated_at||p.created_at);if(!Number.isNaN(d.getTime()))activityDates.add(d.toISOString().slice(0,10));}for(const e of enrolled){const d=new Date(e.created_at);if(!Number.isNaN(d.getTime()))activityDates.add(d.toISOString().slice(0,10));}let streak=0;for(let i=0;i<365;i++){const d=new Date(Date.now()-i*86400000).toISOString().slice(0,10);if(activityDates.has(d))streak++;else if(i>0)break}const notifications=db.notices.slice().sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,5);const certificates=courseSummary.filter(c=>c.total>0&&c.percent===100).map(c=>({course_id:c.course_id,title:c.title,eligible:true}));return send(res,200,{user_id:s.user_id,enrolled:enrolled.length,completedLessons,attempts:results.length,avgScore,streak,courseSummary,notifications,certificates})}
if(req.method==='GET'&&p==='/api/admin/security-audit'){if(!requireAdmin(req,res))return;const type=String(query.get('type')||'').trim();const userId=String(query.get('user_id')||'').trim();const q=String(query.get('q')||'').toLowerCase();const limit=Math.min(Math.max(Number(query.get('limit')||200),1),1000);let events=[...db.security_events].filter(e=>(!type||e.type===type)&&(!userId||e.user_id===userId)&&(!q||JSON.stringify(e).toLowerCase().includes(q))).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,limit);let alerts=[...db.security_alerts].filter(e=>(!userId||e.user_id===userId)&&(!q||JSON.stringify(e).toLowerCase().includes(q))).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,limit);const counts={};for(const e of events)counts[e.type]=(counts[e.type]||0)+1;return send(res,200,{summary:{events:events.length,alerts:alerts.length,users:db.users.length,active_sessions:db.sessions.filter(x=>new Date(x.expires_at)>new Date()).length},filters:{type,user_id:userId,q,limit},event_counts:counts,events,alerts})}
if(req.method==='GET'&&p==='/api/admin/security-audit/export'){if(!requireAdmin(req,res))return;const type=String(query.get('type')||'').trim();const userId=String(query.get('user_id')||'').trim();const rows=[...db.security_events].filter(e=>(!type||e.type===type)&&(!userId||e.user_id===userId)).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));const esc=v=>'"'+String(v??'').replace(/"/g,'""')+'"';const csv=['id,user_id,type,created_at,details',...rows.map(e=>[e.id,e.user_id,e.type,e.created_at,JSON.stringify(e.details||{})].map(esc).join(','))].join('\n');res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="rajmukhi-security-audit-v38.csv"'});return res.end(csv)}
if(req.method==='GET'&&p.match(/^\/api\/profile\/public\/[^/]+$/)){const idv=decodeURIComponent(p.split('/').pop());const u=db.users.find(x=>x.id===idv);if(!u)return send(res,404,{error:'profile not found'});const visibility=u.profile_visibility||'private';if(visibility==='private')return send(res,403,{error:'profile is private'});const isStudent=!!(auth(req)?.role==='student');if(visibility==='students'&&!isStudent)return send(res,403,{error:'profile visible to students only'});const courses=db.enrollments.filter(e=>e.user_id===u.id).map(e=>{const c=db.courses.find(x=>x.id===e.course_id);return c?{id:c.id,title:c.title}:null}).filter(Boolean);return send(res,200,{profile:{id:u.id,name:u.name,avatar_url:u.avatar_url||null,email:u.show_email!==false?u.email:undefined,created_at:u.created_at},courses})}
if(req.method==='GET'&&p==='/api/admin/integrity'){
 if(!requireAdmin(req,res))return;
 const checks={
  users:Array.isArray(db.users),students:Array.isArray(db.students),courses:Array.isArray(db.courses),lessons:Array.isArray(db.lessons),
  enrollments:Array.isArray(db.enrollments),progress:Array.isArray(db.progress),results:Array.isArray(db.results),certificates:Array.isArray(db.certificates),
  sessions:Array.isArray(db.sessions),security_events:Array.isArray(db.security_events),security_alerts:Array.isArray(db.security_alerts)
 };
 const orphaned={
  enrollments:db.enrollments.filter(x=>!db.users.some(u=>u.id===x.user_id)||!db.courses.some(c=>c.id===x.course_id)).length,
  progress:db.progress.filter(x=>!db.users.some(u=>u.id===x.user_id)||!db.lessons.some(l=>l.id===x.lesson_id)).length,
  results:db.results.filter(x=>!db.users.some(u=>u.id===x.student_id)||!db.tests.some(t=>t.id===x.test_id)).length,
  certificates:db.certificates.filter(x=>!db.users.some(u=>u.id===x.user_id)||!db.courses.some(c=>c.id===x.course_id)).length
 };
 const healthy=Object.values(checks).every(Boolean)&&Object.values(orphaned).every(v=>v===0);
 return send(res,healthy?200:200,{ok:healthy,checks,orphaned,counts:{users:db.users.length,students:db.students.length,courses:db.courses.length,lessons:db.lessons.length,enrollments:db.enrollments.length,progress:db.progress.length,results:db.results.length,certificates:db.certificates.length}});
}
if(req.method==='GET'&&p==='/api/admin/dashboard'){if(!requireAdmin(req,res))return;const recentResults=[...db.results].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,10);return send(res,200,{students:db.students.length,courses:db.courses.length,lessons:db.lessons.length,notes:db.notes.length,videos:db.videos.length,tests:db.tests.length,attempts:db.results.length,uploads:db.uploads.length,recentResults})}
if(req.method==='GET'&&p==='/api/admin/content'){if(!requireAdmin(req,res))return;const content=[...db.courses.map(x=>({...x,type:'courses'})),...db.lessons.map(x=>({...x,type:'lessons'})),...db.notes.map(x=>({...x,type:'notes'})),...db.videos.map(x=>({...x,type:'videos'})),...db.notices.map(x=>({...x,type:'notices'})),...db.tests.map(x=>({...x,type:'tests'}))];return send(res,200,{content})}
if(req.method==='DELETE'&&p.startsWith('/api/admin/content/')){if(!requireAdmin(req,res))return;const parts=p.split('/');const type=parts[3],itemId=parts[4];const map={courses:'courses',notes:'notes',videos:'videos',notices:'notices',tests:'tests',lessons:'lessons'};const key=map[type];if(!key)return send(res,400,{error:'unsupported content type'});const item=db[key].find(x=>x.id===itemId);if(!item)return send(res,404,{error:'content not found'});if(type==='courses'){db.courses=db.courses.filter(x=>x.id!==itemId);db.lessons=db.lessons.filter(x=>x.course_id!==itemId);db.enrollments=db.enrollments.filter(x=>x.course_id!==itemId);db.progress=db.progress.filter(x=>x.course_id!==itemId);db.tests=db.tests.filter(x=>x.course_id!==itemId)}
else {db[key]=db[key].filter(x=>x.id!==itemId);if(type==='lessons')db.progress=db.progress.filter(x=>x.lesson_id!==itemId);}
saveDB();return send(res,200,{ok:true,deleted:itemId})}

if(req.method==='POST'&&p==='/api/admin/upload'){if(!requireAdmin(req,res))return;try{const b=await readBody(req);if(!b.filename||!b.content_base64)return send(res,400,{error:'filename and content_base64 are required'});const clean=String(b.filename).replace(/[^a-zA-Z0-9._-]/g,'_');const fileName=Date.now()+'_'+clean;const filePath=path.join(UPLOAD_DIR,fileName);fs.writeFileSync(filePath,Buffer.from(b.content_base64,'base64'));const item={id:id(),filename:clean,url:'/uploads/'+fileName,size:fs.statSync(filePath).size,created_at:new Date().toISOString()};db.uploads.push(item);saveDB();return send(res,201,item)}catch{return send(res,400,{error:'upload failed'})}}
if(req.method==='DELETE'&&p.startsWith('/api/admin/uploads/')){
 if(!requireAdmin(req,res))return;
 const uid=decodeURIComponent(p.split('/').pop());
 const idx=db.uploads.findIndex(x=>String(x.id)===String(uid));
 if(idx<0)return send(res,404,{error:'upload not found'});
 const item=db.uploads[idx];
 const fileName=path.basename(String(item.url||''));
 const fp=path.join(UPLOAD_DIR,fileName);
 try{if(fs.existsSync(fp))fs.unlinkSync(fp)}catch{}
 db.uploads.splice(idx,1);saveDB();return send(res,200,{ok:true,deleted:uid});
}
if(req.method==='GET'&&p==='/api/uploads'){if(!requireAdmin(req,res))return;return send(res,200,db.uploads)}
if(req.method==='GET'&&p.startsWith('/uploads/')){const f=path.basename(p);const fp=path.join(UPLOAD_DIR,f);if(!fs.existsSync(fp))return send(res,404,{error:'file not found'});const ext=path.extname(fp).toLowerCase();const types={'.pdf':'application/pdf','.mp4':'video/mp4','.webm':'video/webm','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'};res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Access-Control-Allow-Origin':'*','Content-Disposition':'inline'});return fs.createReadStream(fp).pipe(res)}
if(req.method==='GET'&&p==='/api/profile/settings'){const s=requireUser(req,res);if(!s)return;const u=db.users.find(x=>x.id===s.user_id);if(!u)return send(res,404,{error:'user not found'});return send(res,200,{settings:{email_notifications:u.email_notifications!==false,learning_reminders:u.learning_reminders!==false,certificate_updates:u.certificate_updates!==false,profile_visibility:u.profile_visibility||'private',show_email:u.show_email===true},avatar_url:u.avatar_url||null})}
if(req.method==='PUT'&&p==='/api/profile/settings'){const s=requireUser(req,res);if(!s)return;const u=db.users.find(x=>x.id===s.user_id);if(!u)return send(res,404,{error:'user not found'});const b=await readBody(req);for(const k of ['email_notifications','learning_reminders','certificate_updates','show_email'])if(typeof b[k]==='boolean')u[k]=b[k];if(['private','students','public'].includes(b.profile_visibility))u.profile_visibility=b.profile_visibility;saveDB();return send(res,200,{ok:true})}
if(req.method==='PUT'&&p==='/api/profile/password'){const s=requireUser(req,res);if(!s)return;const u=db.users.find(x=>x.id===s.user_id);if(!u)return send(res,404,{error:'user not found'});const b=await readBody(req);if(!b.current_password||!b.new_password)return send(res,400,{error:'current_password and new_password are required'});if(u.password_hash!==hash(b.current_password))return send(res,401,{error:'current password is incorrect'});if(String(b.new_password).length<6)return send(res,400,{error:'new password must be at least 6 characters'});u.password_hash=hash(b.new_password);db.security_events.push({id:id(),user_id:s.user_id,type:'password_changed',created_at:new Date().toISOString()});db.sessions=db.sessions.filter(x=>x.token===s.token);saveDB();return send(res,200,{ok:true})}
if(req.method==='GET'&&p==='/api/profile/sessions'){const s=requireUser(req,res);if(!s)return;const list=db.sessions.filter(x=>x.user_id===s.user_id).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).map(x=>({id:x.token.slice(0,10),created_at:x.created_at,expires_at:x.expires_at,current:x.token===s.token,active:new Date(x.expires_at)>new Date()}));return send(res,200,{sessions:list})}
if(req.method==='DELETE'&&p==='/api/profile/sessions'){const s=requireUser(req,res);if(!s)return;db.sessions=db.sessions.filter(x=>x.user_id!==s.user_id||x.token===s.token);db.security_events.push({id:id(),user_id:s.user_id,type:'sessions_revoked',created_at:new Date().toISOString()});saveDB();return send(res,200,{ok:true})}
if(req.method==='GET'&&p==='/api/profile/security-events'){const s=requireUser(req,res);if(!s)return;return send(res,200,{events:db.security_events.filter(x=>x.user_id===s.user_id).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,20)})}
if(req.method==='POST'&&p==='/api/profile/2fa/setup'){const s=requireUser(req,res);if(!s)return;const u=db.users.find(x=>x.id===s.user_id);if(!u)return send(res,404,{error:'user not found'});u.two_factor_enabled=false;u.two_factor_secret=base32Encode(crypto.randomBytes(20));db.security_events.push({id:id(),user_id:s.user_id,type:'2fa_setup_started',created_at:new Date().toISOString()});saveDB();return send(res,200,{enabled:false,secret:u.two_factor_secret,otpauth_uri:`otpauth://totp/Rajmukhi%20Education:${encodeURIComponent(u.email)}?secret=${u.two_factor_secret}&issuer=Rajmukhi%20Education`,message:'Add this secret to an authenticator app, then verify the 6-digit code.'})}
if(req.method==='POST'&&p==='/api/profile/2fa/confirm'){const s=requireUser(req,res);if(!s)return;const u=db.users.find(x=>x.id===s.user_id);if(!u||!u.two_factor_secret)return send(res,400,{error:'start 2FA setup first'});const b=await readBody(req);if(!verifyTotp(u.two_factor_secret,b.code))return send(res,400,{error:'invalid authenticator code'});u.two_factor_enabled=true;u.recovery_codes=generateRecoveryCodes();db.security_events.push({id:id(),user_id:s.user_id,type:'2fa_enabled',created_at:new Date().toISOString()});saveDB();return send(res,200,{ok:true,enabled:true,recovery_codes:u.recovery_codes})}
if(req.method==='POST'&&p==='/api/profile/2fa/disable'){const s=requireUser(req,res);if(!s)return;const u=db.users.find(x=>x.id===s.user_id);if(u){u.two_factor_enabled=false;delete u.two_factor_secret;db.security_events.push({id:id(),user_id:s.user_id,type:'2fa_disabled',created_at:new Date().toISOString()});saveDB()}return send(res,200,{ok:true})}
if(req.method==='GET'&&p==='/api/profile/activity'){const s=requireUser(req,res);if(!s)return;const list=db.sessions.filter(x=>x.user_id===s.user_id).sort((a,b)=>new Date(b.created_at||b.expires_at)-new Date(a.created_at||a.expires_at)).slice(0,10).map(x=>({created_at:x.created_at||null,expires_at:x.expires_at,active:new Date(x.expires_at)>new Date()}));return send(res,200,{activity:list.map(x=>({...x,device_label:x.device_label||'Web browser',device_id:x.device_id||null}))})}
if(req.method==='PUT'&&p==='/api/profile/avatar'){const s=requireUser(req,res);if(!s)return;const b=await readBody(req);const data=String(b.data_url||'');if(!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(data))return send(res,400,{error:'valid image data required'});if(data.length>700000)return send(res,413,{error:'image too large'});const u=db.users.find(x=>x.id===s.user_id);if(!u)return send(res,404,{error:'user not found'});u.avatar_url=data;saveDB();return send(res,200,{avatar_url:data})}
if(req.method==='DELETE'&&p==='/api/profile/avatar'){const s=requireUser(req,res);if(!s)return;const u=db.users.find(x=>x.id===s.user_id);if(u){delete u.avatar_url;saveDB()}return send(res,200,{ok:true})}

if(req.method==='GET'&&p.startsWith('/api/public/profile/')){const sid=decodeURIComponent(p.split('/').pop());const u=db.users.find(x=>x.id===sid)||db.students.find(x=>x.id===sid);if(!u)return send(res,404,{error:'profile not found'});const visibility=u.profile_visibility||'private';if(visibility==='private')return send(res,403,{error:'profile is private'});const enrollments=db.enrollments.filter(x=>x.user_id===sid);const progress=db.progress.filter(x=>x.user_id===sid);const results=db.results.filter(x=>x.student_id===sid||x.user_id===sid);const certs=db.certificates.filter(x=>x.user_id===sid||x.student_id===sid);const completed=progress.filter(x=>x.completed).length;const avg=results.length?Math.round(results.reduce((a,x)=>a+(Number(x.score||0)/(Number(x.total)||1))*100,0)/results.length)+'%':'—';const achievements=[];if(enrollments.length>=1)achievements.push('Course Explorer');if(completed>=1)achievements.push('First Lesson Completed');if(completed>=10)achievements.push('10 Lessons Completed');if(certs.length>=1)achievements.push('Certified Learner');return send(res,200,{profile:{id:u.id,name:u.name,email:u.show_email===true?u.email:undefined,show_email:u.show_email===true,avatar_url:u.avatar_url||null,profile_visibility:visibility},stats:{enrollments:enrollments.length,completed_lessons:completed,certificates:certs.length,average_score:avg},achievements,certificates:certs.map(c=>({id:c.id,certificate_number:c.certificate_no,title:c.course_title,course_name:c.course_title,issue_date:c.issued_at,status:c.status||'active'}))})}

if(req.method==='GET'&&p==='/api/profile/privacy'){const s=requireUser(req,res);if(!s)return;const u=db.users.find(x=>x.id===s.user_id)||{};return send(res,200,{profile_visibility:u.profile_visibility||'private',show_email:u.show_email!==false,marketing_notifications:u.marketing_notifications!==false,learning_reminders:u.learning_reminders!==false,certificate_updates:u.certificate_updates!==false})}
if(req.method==='PUT'&&p==='/api/profile/privacy'){const s=requireUser(req,res);if(!s)return;const u=db.users.find(x=>x.id===s.user_id);if(!u)return send(res,404,{error:'user not found'});const b=await readBody(req);if(b.profile_visibility!==undefined&&!['private','students','public'].includes(b.profile_visibility))return send(res,400,{error:'invalid profile visibility'});if(b.profile_visibility!==undefined)u.profile_visibility=b.profile_visibility;for(const k of ['show_email','marketing_notifications','learning_reminders','certificate_updates'])if(b[k]!==undefined)u[k]=!!b[k];db.security_events.push({id:id(),user_id:s.user_id,type:'privacy_settings_updated',created_at:new Date().toISOString()});saveDB();return send(res,200,{ok:true,privacy:{profile_visibility:u.profile_visibility||'private',show_email:u.show_email!==false,marketing_notifications:u.marketing_notifications!==false,learning_reminders:u.learning_reminders!==false,certificate_updates:u.certificate_updates!==false}})}

if(req.method==='GET'&&p==='/api/profile/data-export'){const s=requireUser(req,res);if(!s)return;const u=db.users.find(x=>x.id===s.user_id);if(!u)return send(res,404,{error:'user not found'});const user={...u};delete user.password_hash;delete user.two_factor_secret;delete user.recovery_codes;const payload={exported_at:new Date().toISOString(),profile:user,enrollments:db.enrollments.filter(x=>x.user_id===s.user_id),progress:db.progress.filter(x=>x.user_id===s.user_id),results:db.results.filter(x=>x.user_id===s.user_id),certificates:db.certificates.filter(x=>x.user_id===s.user_id),security_events:db.security_events.filter(x=>x.user_id===s.user_id),security_alerts:db.security_alerts.filter(x=>x.user_id===s.user_id)};return send(res,200,payload)}

if(req.method==='GET'&&p==='/api/profile/security-alerts'){const s=requireUser(req,res);if(!s)return;const alerts=db.security_alerts.filter(x=>x.user_id===s.user_id).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,50);return send(res,200,{alerts,unread:alerts.filter(x=>!x.read).length})}
if(req.method==='POST'&&p==='/api/profile/security-alerts/read'){const s=requireUser(req,res);if(!s)return;db.security_alerts.filter(x=>x.user_id===s.user_id).forEach(x=>x.read=true);saveDB();return send(res,200,{ok:true})}
if(req.method==='GET'&&p==='/api/profile/recovery-codes'){const s=requireUser(req,res);if(!s)return;const u=db.users.find(x=>x.id===s.user_id);return send(res,200,{enabled:!!u?.two_factor_enabled,remaining:(u?.recovery_codes||[]).length})}
if(req.method==='POST'&&p==='/api/profile/recovery-codes/regenerate'){const s=requireUser(req,res);if(!s)return;const u=db.users.find(x=>x.id===s.user_id);if(!u?.two_factor_enabled||!u.two_factor_secret)return send(res,400,{error:'2FA must be enabled'});const b=await readBody(req);if(!verifyTotp(u.two_factor_secret,b.code))return send(res,400,{error:'valid authenticator code required'});u.recovery_codes=generateRecoveryCodes();db.security_events.push({id:id(),user_id:s.user_id,type:'recovery_codes_regenerated',created_at:new Date().toISOString()});saveDB();return send(res,200,{recovery_codes:u.recovery_codes})}
if(req.method==='PUT'&&p.startsWith('/api/profile/sessions/')){const s=requireUser(req,res);if(!s)return;const token=decodeURIComponent(p.split('/').pop());const session=db.sessions.find(x=>x.token===token&&x.user_id===s.user_id);if(!session)return send(res,404,{error:'session not found'});const b=await readBody(req);session.device_label=String(b.device_label||'').trim().slice(0,80)||session.device_label;saveDB();return send(res,200,{ok:true,device_label:session.device_label})}
if(req.method==='DELETE'&&p.startsWith('/api/profile/sessions/')){const s=requireUser(req,res);if(!s)return;const token=decodeURIComponent(p.split('/').pop());if(token===s.token)return send(res,400,{error:'use logout for current session'});const before=db.sessions.length;db.sessions=db.sessions.filter(x=>!(x.token===token&&x.user_id===s.user_id));if(db.sessions.length===before)return send(res,404,{error:'session not found'});db.security_events.push({id:id(),user_id:s.user_id,type:'session_revoked',created_at:new Date().toISOString()});saveDB();return send(res,200,{ok:true})}
if(req.method==='GET'&&p==='/'){
 return serveFile(res,path.join(__dirname,'index.html'),'text/html; charset=utf-8')
}
if(req.method==='GET'&&p==='/manifest.json'){
 return serveFile(res,path.join(__dirname,'manifest.json'),'application/manifest+json; charset=utf-8')
}
if(req.method==='GET'&&p==='/sw.js'){
 return serveFile(res,path.join(__dirname,'sw.js'),'application/javascript; charset=utf-8')
}
if(req.method==='GET'&&p==='/public-profile')return serveFile(res,path.join(__dirname,'public_profile_v39.html'),'text/html; charset=utf-8')
if(req.method==='GET'&&p==='/security')return serveFile(res,path.join(__dirname,'security_v37.html'),'text/html; charset=utf-8')
if(req.method==='GET'&&p==='/settings')return serveFile(res,path.join(__dirname,'settings_v32.html'),'text/html; charset=utf-8')
if(req.method==='GET'&&p==='/profile')return serveFile(res,path.join(__dirname,'profile_v31.html'),'text/html; charset=utf-8')
if(req.method==='GET'&&p==='/admin')return serveFile(res,path.join(__dirname,'admin_v38.html'),'text/html; charset=utf-8')
if(req.method==='GET'&&(p==='/admin-v25.css'||p==='/admin-v24.css'||p==='/admin-v22.css')){res.writeHead(200,{'Content-Type':'text/css; charset=utf-8'});return fs.createReadStream(path.join(__dirname,'admin-v25.css')).pipe(res)}
if(req.method==='GET'&&(p==='/admin-v25.js'||p==='/admin-v24.js'||p==='/admin-v22.js')){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});return fs.createReadStream(path.join(__dirname,'admin-v25.js')).pipe(res)}
send(res,404,{error:'Not found'})});
const cleanupTimer=setInterval(cleanupExpiredData, 15*60*1000);
const automaticBackupTimer=setInterval(createAutomaticBackup, BACKUP_INTERVAL_MS);
const initialBackup=createAutomaticBackup();
if(initialBackup.error) console.warn('Automatic backup warning:',initialBackup.error);
if (IS_PRODUCTION && USING_DEFAULT_ADMIN_CREDENTIALS) console.warn('WARNING: ADMIN_EMAIL/ADMIN_PASSWORD are not set; configure production admin credentials before public deployment.');
if(cleanupTimer.unref) cleanupTimer.unref();
server.listen(PORT,()=>console.log(`Rajmukhi Education ${APP_VERSION} running on port ${PORT}`));
function shutdown(signal){
 clearInterval(cleanupTimer);clearInterval(automaticBackupTimer);console.log(`${signal} received, shutting down...`);server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),10000).unref()}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));
