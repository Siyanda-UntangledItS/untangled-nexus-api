# Untangled Nexus API — Performance Release Test Report

## Automated validation

- `npm install`: dependencies installed successfully on the validation machine.
- `npm test`: **11/11 tests passed**.
- ZIP integrity: passed.
- Windows test-script compatibility: fixed to use `tests/*.test.mjs`.
- MongoDB TLS configuration: fixed so local `mongodb://localhost:27017/...` does not force TLS. Set `MONGODB_TLS=true` only when the deployment requires TLS.

## Environment-dependent validation

A live MongoDB/API benchmark cannot be certified from this build environment because no MongoDB instance is available here. On the target Windows machine, start MongoDB first, then run the API and benchmark.

## Important runtime notes

If Windows reports `EADDRINUSE` on ports 5001/5002, an earlier API process is still running. Stop the existing Node processes before starting the API again.

Recommended validation:

```powershell
npm install
npm run typecheck
npm test
npm run dev
```

Then, in another terminal:

```powershell
npm run benchmark
```

The API uses ports 5001 and 5002 in development as configured by the package scripts.
