// Image Match regression suite. Run: node tests/run.cjs
// Each fixture is the OCR text per region (real Tesseract output where noted);
// the pipeline runs for real with only the Tesseract call stubbed.
const fs=require('fs'), path=require('path');
const CASES=[
  ['robinson.json',    'real OCR', {player:'Brian Robinson Jr.', team:'Washington Commanders'}],
  ['vandeweghe.json',  'real OCR', {player:'Kiki VanDeWeghe'}],
  ['wembanyama.json',  'real OCR', {player:'Victor Wembanyama', team:'San Antonio Spurs'}],
  ['curry.json',       'real OCR', {player:'Stephen Curry'}],
  ['siephen-cuny.json','typed',    {player:'Stephen Curry'}],
  ['garbage.json',     'typed',    {player:''}],
  ['unlisted.json',    'typed',    {player:'TAVIAN QUORRELL', team:'Orlando Magic', card_no:'301'}],
  ['@card',            'fixture',  {player:'Ausar Thompson', team:'Detroit Pistons', card_no:'262', insert:'NBA Debut'}],
];
function ctx(){ return {drawImage(){},fillRect(){},getImageData:(x,y,w,h)=>({data:new Uint8ClampedArray(Math.max(1,w*h)*4)}),putImageData(){},translate(){},rotate(){},scale(){},save(){},restore(){},setTransform(){},fillStyle:'',imageSmoothingEnabled:true}; }
function el(){ return new Proxy({style:{},classList:{add(){},remove(){},toggle(){}},hidden:false,innerHTML:'',options:[],children:[],value:'',width:600,height:840,getContext:ctx,appendChild(){},addEventListener(){},setAttribute(){},querySelector:()=>el(),querySelectorAll:()=>[]},{get:(t,k)=>k in t?t[k]:(()=>el()),set:(t,k,v)=>{t[k]=v;return true;}}); }
const ELS={};
global.document={getElementById:id=>ELS[id]||(ELS[id]=el()),querySelector:()=>el(),querySelectorAll:()=>[],addEventListener(){},createElement:()=>({style:{},width:1,height:1,getContext:ctx,appendChild(){}}),body:{appendChild(){},removeChild(){},addEventListener(){}}};
global.localStorage={getItem:()=>null,setItem(){},removeItem(){}};
global.window=global; global.addEventListener=function(){}; global.navigator={}; global.fetch=async()=>({ok:false,json:async()=>({})}); global.Image=function(){};
const h=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const re=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g; let m,last; while((m=re.exec(h))) last=m[1];
const tmp=path.join(require('os').tmpdir(),'im-under-test.cjs');
fs.writeFileSync(tmp, last+';imRender=function(){};imVault=function(){};imProg=function(){};module.exports={IM,imRun,IM_FIXTURES,imStubCanvas};');
const M=require(tmp);
(async()=>{
  let fail=0;
  for(const [file,kind,want] of CASES){
    const stub = file==='@card' ? M.IM_FIXTURES.card : JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures',file),'utf8'));
    Object.assign(M.IM,{front:M.imStubCanvas(600,840),back:M.imStubCanvas(600,840),label:null,mode:'card',raw:{},shots:[],stub,stubColour:null});
    await M.imRun();
    const f=M.IM.fields||{}, bad=[];
    for(const k in want) if(String(f[k]||'')!==want[k]) bad.push(k+': got "'+(f[k]||'')+'", want "'+want[k]+'"');
    console.log((bad.length?'FAIL':'pass')+'  '+file.padEnd(20)+kind.padEnd(10)+(bad.length?bad.join('; '):Object.values(want).filter(Boolean).join(' / ')));
    if(bad.length) fail++;
  }
  console.log(fail?('\n'+fail+' failing'):'\nall passing');
  process.exit(fail?1:0);
})();
