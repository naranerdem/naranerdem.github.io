// Disposable local measurement only; never a deployed entrypoint.
import worker from "../src/worker";

export default {
  async fetch(request: Request, env: any, ctx: any) {
    if (!['127.0.0.1', 'localhost'].includes(new URL(request.url).hostname)) {
      return new Response('Local profile only', { status: 403 });
    }
    const stats = { queries: 0, rowsRead: 0, dbMs: 0 };
    const record = (result: any) => {
      stats.queries++;
      stats.rowsRead += Number(result.meta?.rows_read || 0);
      stats.dbMs += Number(result.meta?.duration || 0);
      return result;
    };
    const wrap = (statement: any): any => ({
      bind: (...values: any[]) => wrap(statement.bind(...values)),
      all: async () => record(await statement.all()),
      run: async () => record(await statement.run()),
      first: async (column?: string) => {
        const row = record(await statement.all()).results?.[0] ?? null;
        return column && row ? row[column] : row;
      },
      raw: (...args: any[]) => statement.raw(...args),
      statement,
    });
    const db = {
      prepare: (sql: string) => wrap(env.DB.prepare(sql)),
      batch: async (statements: any[]) => (await env.DB.batch(statements.map(s => s.statement))).map(record),
      exec: (sql: string) => env.DB.exec(sql),
    };
    const started = performance.now();
    const response = await worker.fetch(request, { ...env, DB: db }, ctx);
    const headers = new Headers(response.headers);
    headers.set('X-Test-D1-Queries', String(stats.queries));
    headers.set('X-Test-D1-Rows-Read', String(stats.rowsRead));
    headers.set('X-Test-D1-Ms', String(stats.dbMs));
    headers.set('X-Test-Elapsed-Ms', String(performance.now() - started));
    return new Response(response.body, { status: response.status, headers });
  },
};
