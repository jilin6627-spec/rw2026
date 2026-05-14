const http = require("http"); const fs = require("fs"); const path = require("path");
const { spawn } = require("child_process"); const crypto = require("crypto");
const PORT = process.env.PORT || 3000; const FILE_PATH = process.env.FILE_PATH || "/app/tmp";
const XRAY_BIN = path.join(FILE_PATH,"xray"); const CONFIG_TEMPLATE = path.join(FILE_PATH,"config.json.template");
const CONFIG_FILE = path.join(FILE_PATH,"config.json");
function generateConfig(){ let cfg = fs.readFileSync(CONFIG_TEMPLATE,"utf-8");
  const uuid = process.env.XRAY_UUID || crypto.randomUUID(); cfg = cfg.replace(/REPLACE_WITH_UUID/g, uuid);
  fs.writeFileSync(CONFIG_FILE, cfg); console.log("[CONFIG] Xray config:", CONFIG_FILE); return uuid; }
function startXray(){ const xray = spawn(XRAY_BIN,["-c",CONFIG_FILE],{stdio:["pipe","inherit","inherit"]});
  xray.on("error",(err)=>console.error("[XRAY] 启动失败:",err.message));
  xray.on("exit",(code)=>console.error("[XRAY] 退出, code:",code));
  console.log("[XRAY] 启动 Xray-core..."); }
fs.mkdirSync(FILE_PATH,{recursive:true}); const uuid = generateConfig(); startXray();
const server = http.createServer((req,res)=>{ if(req.url==="/health"){res.writeHead(200);return res.end("OK");}
  if(req.url==="/uuid"){res.writeHead(200,{"Content-Type":"text/plain"});return res.end(uuid);}
  res.writeHead(200,{"Content-Type":"application/json"}); res.end(JSON.stringify({status:"ok",message:"rw2026 fixed",uuid}));});
server.listen(PORT,()=>console.log(`[HTTP] 0.0.0.0:${PORT}`));
process.on("uncaughtException",(err)=>console.error("[FATAL]",err));
