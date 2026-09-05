const baseUrl = process.env.API_URL || `http://localhost:${process.env.PORT || 5001}`;
const paths = (process.env.BENCHMARK_PATHS || '/api/health,/api/products?limit=24,/api/services?limit=24,/api/catalog?limit=50').split(',');
const runs = Math.max(Number(process.env.BENCHMARK_RUNS || 10), 1);

async function measure(path) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    const response = await fetch(`${baseUrl}${path}`);
    await response.arrayBuffer();
    samples.push(performance.now() - started);
    if (!response.ok) console.warn(`WARN ${path}: HTTP ${response.status}`);
  }
  samples.sort((a, b) => a - b);
  const avg = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
  return { avg, p95, min: samples[0], max: samples[samples.length - 1] };
}

console.log(`Benchmarking ${baseUrl} (${runs} runs each)`);
for (const path of paths) {
  try {
    const result = await measure(path.trim());
    console.log(`${path.trim()} | avg ${result.avg.toFixed(1)}ms | p95 ${result.p95.toFixed(1)}ms | min ${result.min.toFixed(1)}ms | max ${result.max.toFixed(1)}ms`);
  } catch (error) {
    console.error(`${path.trim()} | FAILED | ${error.message}`);
  }
}
