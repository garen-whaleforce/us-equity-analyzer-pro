import axios from 'axios';
import { getCache, setCache } from './cache.js';

const FH_BASE = 'https://finnhub.io/api/v1';

export async function finnhubPriceTarget(symbol, key){
  const cacheKey = `finnhub_pt_${symbol}`;
  let cached = await getCache(cacheKey);
  if(cached) return cached;
  try{
    const {data} = await axios.get(`${FH_BASE}/stock/price-target`,{
      params:{ symbol, token:key }, timeout:15000
    });
    // Finnhub 回傳 {symbol,targetHigh,targetLow,targetMean,targetMedian, lastUpdated?}
    if(data?.targetMean || data?.targetHigh || data?.targetLow){
      await setCache(cacheKey,data);
      return data;
    }
    throw new Error('Empty price-target payload');
  }catch(err){
    throw new Error(`[FINNHUB] ${err.response?.data?.error || err.message}`);
  }
}

export async function yahooPriceTarget(symbol){
  const cacheKey = `yahoo_pt_${symbol}`;
  let cached = await getCache(cacheKey);
  if(cached) return cached;
  try{
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=financialData`;
    const {data} = await axios.get(url,{
      headers:{ 'User-Agent':'Mozilla/5.0' }, timeout:15000
    });
    const fd = data?.quoteSummary?.result?.[0]?.financialData;
    const out = {
      source: 'yahoo',
      targetHigh: fd?.targetHighPrice?.raw ?? null,
      targetLow:  fd?.targetLowPrice?.raw ?? null,
      targetMean: fd?.targetMeanPrice?.raw ?? null,
      targetMedian: null
    };
    if(out.targetHigh||out.targetLow||out.targetMean){
      await setCache(cacheKey, out);
      return out;
    }
    throw new Error('Yahoo no financialData targets');
  }catch(err){
    throw new Error(`[YAHOO] ${err.message}`);
  }
}

export async function alphaVantageTarget(symbol, apiKey){
  if(!apiKey) throw new Error('[ALPHAVANTAGE] Missing API key');
  const cacheKey = `av_overview_${symbol}`;
  let cached = await getCache(cacheKey);
  if(cached) return cached;
  try{
    const {data} = await axios.get('https://www.alphavantage.co/query',{
      params:{ function:'OVERVIEW', symbol, apikey: apiKey }, timeout:20000
    });
    // 包含 AnalystTargetPrice 欄位
    if(data?.AnalystTargetPrice){
      const num = Number(data.AnalystTargetPrice);
      const out = { source:'alphavantage', targetHigh:null, targetLow:null, targetMean: isNaN(num)?null:num, targetMedian:null };
      await setCache(cacheKey, out);
      return out;
    }
    throw new Error('AlphaVantage no AnalystTargetPrice');
  }catch(err){
    throw new Error(`[ALPHAVANTAGE] ${err.message}`);
  }
}

// 聚合器：Finnhub → Yahoo → AlphaVantage
export async function getAggregatedPriceTarget(symbol, finnhubKey, alphaKey){
  const errors = [];
  try{
    const fh = await finnhubPriceTarget(symbol, finnhubKey);
    return { source:'finnhub', ...fh };
  }catch(e){ errors.push(e.message); }
  try{
    const y = await yahooPriceTarget(symbol);
    return y;
  }catch(e){ errors.push(e.message); }
  try{
    const av = await alphaVantageTarget(symbol, alphaKey);
    return av;
  }catch(e){ errors.push(e.message); }
  throw new Error(errors.join(' | '));
}
