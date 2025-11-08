import axios from 'axios';
import dayjs from 'dayjs';
import { getCache, setCache } from './cache.js';

const FH_BASE = 'https://finnhub.io/api/v1';

function toNumber(value){
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function getCached(key, fetcher){
  const cached = await getCache(key);
  if(cached) return cached;
  const fresh = await fetcher();
  if(fresh) await setCache(key, fresh);
  return fresh;
}

async function finnhubHistorical(symbol, date, key){
  if(!key) throw new Error('Missing Finnhub key');
  const cacheKey = `hist_finnhub_${symbol}_${date}`;
  return getCached(cacheKey, async ()=>{
    const from = dayjs(date).startOf('day').unix();
    const to = dayjs(date).endOf('day').unix();
    const {data} = await axios.get(`${FH_BASE}/stock/candle`,{
      params:{ symbol, resolution:'D', from, to, token:key },
      timeout:15000
    });
    if(data?.s === 'ok' && Array.isArray(data?.c) && data.c.length){
      const price = toNumber(data.c[data.c.length-1]);
      if(price!=null) return { price, source: 'finnhub_candle' };
    }
    throw new Error(data?.s || 'Finnhub candle no data');
  });
}

async function alphaHistorical(symbol, date, key){
  if(!key) throw new Error('Missing AlphaVantage key');
  const cacheKey = `hist_alpha_${symbol}_${date}`;
  return getCached(cacheKey, async ()=>{
    const {data} = await axios.get('https://www.alphavantage.co/query',{
      params:{ function:'TIME_SERIES_DAILY', symbol, apikey:key },
      timeout:20000
    });
    const series = data?.['Time Series (Daily)'];
    const row = series?.[date];
    const price = toNumber(row?.['4. close']);
    if(price!=null) return { price, source:'alphavantage_daily' };
    throw new Error('AlphaVantage no data for date');
  });
}

async function yahooHistorical(symbol, date){
  const cacheKey = `hist_yahoo_${symbol}_${date}`;
  return getCached(cacheKey, async ()=>{
    const from = dayjs(date).startOf('day').unix();
    const to = dayjs(date).endOf('day').unix() + 86400;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${from}&period2=${to}&includePrePost=false&events=div%2Csplit`;
    const {data} = await axios.get(url,{ headers:{'User-Agent':'Mozilla/5.0'}, timeout:15000 });
    const result = data?.chart?.result?.[0];
    const close = result?.indicators?.quote?.[0]?.close?.[0];
    const price = toNumber(close);
    if(price!=null) return { price, source:'yahoo_chart' };
    throw new Error('Yahoo chart no data');
  });
}

export async function getHistoricalPrice(symbol, date, { finnhubKey, alphaKey }){
  const errors = [];
  const normalizedDate = dayjs(date).format('YYYY-MM-DD');
  const runners = [
    ()=>finnhubHistorical(symbol, normalizedDate, finnhubKey),
    ()=>alphaHistorical(symbol, normalizedDate, alphaKey),
    ()=>yahooHistorical(symbol, normalizedDate)
  ];
  for(const run of runners){
    try{
      const result = await run();
      if(result) return { ...result, date: normalizedDate };
    }catch(err){
      errors.push(err.message);
    }
  }
  throw new Error(errors.join(' | ') || 'No historical price source succeeded');
}
