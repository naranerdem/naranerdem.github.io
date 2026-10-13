import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: ['src/server/staff/attendance-payment-card.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { attendancePaymentCardTarget } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
let queries = 0;
const env = { DB: { prepare: () => { queries++; throw new Error('must reject before querying'); } } };
await assert.rejects(attendancePaymentCardTarget(env, { capabilities: ['attendance.view'] }, 'legacy:enrollment'), error => error.code === 'forbidden');
await assert.rejects(attendancePaymentCardTarget(env, { capabilities: ['payment.view'] }, '<malformed>'), error => error.code === 'invalid');
assert.equal(queries, 0);
console.log('ok attendance-only permission and malformed identity rejected before database lookup');
