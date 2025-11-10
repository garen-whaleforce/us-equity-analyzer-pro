import axios from 'axios';
import dayjs from 'dayjs';
import { getCache, setCache } from './cache.js';
import { getFmpHistorical } from './fmp.js';

const FH_BASE = 'https://finnhub.io/api/v1';
const MAX_LOOKBACK_DAYS = 7;

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
  const cacheKey = `hist_finnhub_${symbol}_${date}`;
  return getCached(cacheKey, async ()=>{
    if(!key) throw new Error('Missing Finnhub key');
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
  const cacheKey = `hist_alpha_${symbol}_${date}`;
  return getCached(cacheKey, async ()=>{
    if(!key) throw new Error('Missing AlphaVantage key');
    const {data} = await axios.get('https://www.alphavantage.co/query',{
      params:{
        function:'TIME_SERIES_DAILY_ADJUSTED',
        symbol,
        outputsize:'full',
        apikey:key
      },
      timeout:20000
    });
    const series = data?.['Time Series (Daily)'];
    const row = series?.[date];
    const price = toNumber(row?.['4. close'] ?? row?.['5. adjusted close']);
    if(price!=null) return { price, source:'alphavantage_daily' };
    throw new Error('AlphaVantage no data for date');
  });
}

async function stooqHistorical(symbol, date){
  const cacheKey = `hist_stooq_${symbol}_${date}`;
  return getCached(cacheKey, async ()=>{
    const key = symbol.toLowerCase() + '.us';
    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(key)}&i=d`;
    const {data} = await axios.get(url,{ timeout:15000 });
    const lines = data.split('\n').map(l=>l.trim()).filter(Boolean);
    if(lines.length < 2) throw new Error('Stooq no data');
    const head = lines[0].split(',');
    const idxDate = head.indexOf('Date');
    const idxClose = head.indexOf('Close');
    for(const line of lines.slice(1)){
      const cols = line.split(',');
      if(cols[idxDate] === date){
        const price = toNumber(cols[idxClose]);
        if(price!=null) return { price, source:'stooq_csv' };
      }
    }
    throw new Error('Stooq no data for date');
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

async function twelveHistorical(symbol, date, key){
  const cacheKey = `hist_twelve_${symbol}_${date}`;
  return getCached(cacheKey, async ()=>{
    if(!key) throw new Error('Missing Twelve Data key');
    const params = {
      symbol,
      interval: '1day',
      outputsize: 5000,
      timezone: 'UTC',
      apikey: key
    };
    const {data} = await axios.get('https://api.twelvedata.com/time_series',{ params, timeout:15000 });
    if(data?.status === 'ok' && Array.isArray(data?.values)){
      const match = data.values.find(v=>v.datetime === date);
      const val = match?.close ?? match?.price;
      const price = toNumber(val);
      if(price!=null) return { price, source:'twelvedata' };
    }
    throw new Error(data?.message || 'Twelve Data no data');
  });
}

async function trySourcesForDate(symbol, targetDate, { finnhubKey, alphaKey, twelveKey }){
  const normalizedDate = dayjs(targetDate).format('YYYY-MM-DD');
  const runners = [];
  if(finnhubKey) runners.push(()=>finnhubHistorical(symbol, normalizedDate, finnhubKey));
  if(alphaKey) runners.push(()=>alphaHistorical(symbol, normalizedDate, alphaKey));
  runners.push(()=>yahooHistorical(symbol, normalizedDate));
  runners.push(()=>stooqHistorical(symbol, normalizedDate));
  if(twelveKey) runners.push(()=>twelveHistorical(symbol, normalizedDate, twelveKey));
  const errors = [];
  for(const run of runners){
    try{
      const result = await run();
      if(result) return { ...result, date: normalizedDate };
    }catch(err){
      errors.push(`${normalizedDate}:${err.message}`);
    }
  }
  return { errors };
}

export async function getHistoricalPrice(symbol, date, keys){
  const errors = [];
  const target = dayjs(date);
  const { fmpKey, ...fallbackKeys } = keys || {};

  if(fmpKey){
    for(let offset=0; offset<=MAX_LOOKBACK_DAYS; offset++){
      const currentDate = target.subtract(offset, 'day');
      const normalized = currentDate.format('YYYY-MM-DD');
      const dow = currentDate.day();
      if(dow === 0 || dow === 6){
        errors.push(`${normalized}:non-trading-day`);
        continue;
      }
      try{
        const hist = await getFmpHistorical(symbol, normalized, fmpKey);
        if(hist?.price!=null) return hist;
      }catch(err){
        errors.push(`${normalized}:FMP:${err.message}`);
      }
    }
  }

  for(let offset=0; offset<=MAX_LOOKBACK_DAYS; offset++){
    const currentDate = target.subtract(offset, 'day');
    const dow = currentDate.day();
    if(dow === 0 || dow === 6){
      errors.push(`${currentDate.format('YYYY-MM-DD')}:non-trading-day`);
      continue;
    }
    const attempt = await trySourcesForDate(symbol, currentDate, fallbackKeys);
    if(attempt?.price!=null){
      return attempt;
    }
    if(attempt?.errors?.length){
      errors.push(...attempt.errors);
    }
  }
  throw new Error(errors.join(' | ') || 'No historical price source succeeded within lookback window');
}
