import 'dotenv/config';
// Fetch S&P 500 constituents, pick top 100 by market cap via FMP,
// run full analysis (LLM) for each ticker, and output a CSV sorted by
// target price vs current price delta (desc).
import fs from 'fs';
import path from 'path';

const FMP_KEY = process.env.FMP_API_KEY || process.env.FMP_KEY;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ANALYSIS_DATE = process.env.ANALYSIS_DATE || new Date().toISOString().slice(0, 10);
const OUTPUT_DIR = path.resolve('outputs');
const OUTPUT_FILE = path.join(OUTPUT_DIR, `sp500_top100_${ANALYSIS_DATE}.csv`);

if (!FMP_KEY) {
  console.error('Missing FMP_API_KEY');
  process.exit(1);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return await res.json();
}

async function getSp500Symbols() {
  const url = `https://financialmodelingprep.com/stable/sp500-constituent?apikey=${FMP_KEY}`;
  const data = await fetchJson(url);
  return Array.isArray(data) ? data.map(row => row.symbol).filter(Boolean) : [];
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

async function getMarketCaps(symbols) {
  const chunks = chunk(symbols, 50);
  const rows = [];
  for (const c of chunks) {
    const url = `https://financialmodelingprep.com/stable/batch-quote?symbols=${c.join(',')}&apikey=${FMP_KEY}`;
    try {
      const data = await fetchJson(url);
      if (Array.isArray(data)) rows.push(...data);
    } catch (err) {
      console.warn('[batch-quote]', err.message);
    }
  }
  return rows
    .map(row => ({
      symbol: row.symbol,
      marketCap: toNum(row.marketCap ?? row.marketcap ?? row.market_cap ?? row.marketCapitalization),
      price: toNum(row.price ?? row.c ?? row.currentPrice)
    }))
    .filter(r => r.symbol && r.marketCap);
}

async function runAnalysis(ticker) {
  const started = Date.now();
  const body = { ticker, date: ANALYSIS_DATE };
  const res = await fetch(`${BASE_URL}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON response: ${text.slice(0, 200)}`);
  }
  if (!res.ok || data.error) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  const elapsed = (Date.now() - started) / 1000;
  const usage = data.llm_usage || data.analysis?.__usage || {};
  const tokens = usage.total_tokens ?? null;
  const cost = usage.total_cost ?? null;
  const action = data.analysis?.action || {};
  const priceMeta = data.fetched?.finnhub_summary?.price_meta || {};
  const current = toNum(priceMeta.value);
  const target = toNum(action.target_price);
  const delta = current && target ? (target / current) - 1 : null;

  return {
    ticker,
    rating: action.rating || '',
    target_price: target,
    current_price: current,
    target_delta: delta,
    confidence: action.confidence || '',
    elapsed,
    tokens,
    cost,
    raw_usage: usage,
    price_as_of: priceMeta.as_of || '',
    target_band: action.target_band || null
  };
}

function toCsv(rows) {
  const headers = [
    'ticker',
    'rating',
    'current_price',
    'target_price',
    'target_delta_pct',
    'price_as_of',
    'llm_tokens',
    'llm_cost_usd',
    'elapsed_sec'
  ];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      r.ticker,
      r.rating,
      r.current_price ?? '',
      r.target_price ?? '',
      r.target_delta != null ? (r.target_delta * 100).toFixed(2) : '',
      r.price_as_of,
      r.tokens ?? '',
      r.cost ?? '',
      r.elapsed.toFixed(2)
    ].join(','));
  }
  return lines.join('\n');
}

async function main() {
  console.log(`Fetching S&P 500 list...`);
  const symbols = await getSp500Symbols();
  console.log(`Got ${symbols.length} symbols, fetching market caps...`);
  const quotes = await getMarketCaps(symbols);
  const top100 = quotes
    .sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0))
    .slice(0, 100)
    .map(r => r.symbol);
  console.log(`Top 100 symbols by market cap:`, top100.join(', '));

  const results = [];
  let totalCost = 0;
  for (let i = 0; i < top100.length; i++) {
    const ticker = top100[i];
    try {
      const r = await runAnalysis(ticker);
      results.push(r);
      if (r.cost) totalCost += Number(r.cost) || 0;
      console.log(
        `[${i + 1}/${top100.length}] ${ticker} rating=${r.rating} target=${r.target_price} current=${r.current_price} ` +
        `delta=${r.target_delta != null ? (r.target_delta * 100).toFixed(1) + '%' : 'n/a'} time=${r.elapsed.toFixed(1)}s ` +
        `tokens=${r.tokens ?? '?'} cost=${r.cost ?? '?'}`
      );
    } catch (err) {
      console.error(`[${i + 1}/${top100.length}] ${ticker} failed: ${err.message}`);
    }
  }

  const sorted = results
    .filter(r => r.target_delta != null)
    .sort((a, b) => (b.target_delta || 0) - (a.target_delta || 0));

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  fs.writeFileSync(OUTPUT_FILE, toCsv(sorted), 'utf8');
  console.log(`
Saved CSV to ${OUTPUT_FILE}`);
  console.log(`Total completed: ${results.length}/${top100.length}`);
  console.log(`Estimated total LLM cost: $${totalCost.toFixed(4)}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
