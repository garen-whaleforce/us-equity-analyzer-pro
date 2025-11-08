import fs from 'fs';
import path from 'path';
const CACHE_DIR = path.resolve('cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

export function cachePath(key){ return path.join(CACHE_DIR, encodeURIComponent(key)+'.json'); }

export async function getCache(key, maxAgeMs=24*60*60*1000){
  try{
    const p = cachePath(key);
    if(!fs.existsSync(p)) return null;
    const stat = fs.statSync(p);
    if(Date.now() - stat.mtimeMs > maxAgeMs) return null;
    const raw = fs.readFileSync(p,'utf8');
    return JSON.parse(raw);
  }catch{ return null; }
}

export async function setCache(key, data){
  try{
    const p = cachePath(key);
    fs.writeFileSync(p, JSON.stringify(data));
  }catch{}
}
