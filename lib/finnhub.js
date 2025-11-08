import axios from 'axios';
import { getCache, setCache } from './cache.js';
const BASE = 'https://finnhub.io/api/v1';

async function cachedGet(key, url){
  const c = await getCache(key);
  if(c) return c;
  const {data} = await axios.get(url,{timeout:15000});
  await setCache(key, data);
  return data;
}

export async function getRecommendations(symbol, key, context='latest'){
  try{ return await cachedGet(`fh_reco_${symbol}_${context}`, `${BASE}/stock/recommendation?symbol=${symbol}&token=${key}`); }
  catch(err){ throw new Error(`[FINNHUB] ${err.response?.data?.error || err.message}`); }
}

export async function getEarnings(symbol, key, context='latest'){
  try{ return await cachedGet(`fh_earn_${symbol}_${context}`, `${BASE}/stock/earnings?symbol=${symbol}&token=${key}`); }
  catch(err){ throw new Error(`[FINNHUB] ${err.response?.data?.error || err.message}`); }
}

export async function getQuote(symbol, key, context='latest'){
  try{ return await cachedGet(`fh_quote_${symbol}_${context}`, `${BASE}/quote?symbol=${symbol}&token=${key}`); }
  catch(err){ throw new Error(`[FINNHUB] ${err.response?.data?.error || err.message}`); }
}
