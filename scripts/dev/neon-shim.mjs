// Stands in for @neondatabase/serverless when the local server runs against a
// plain Postgres (server.mjs sets it up). Only what api/ uses: the sql``
// tagged template and sql.transaction([...]). Rows come back as the Neon HTTP
// driver gives them: int8 as a string, timestamps parsed by pg.
import pg from 'pg';

const pools = new Map();

function pool(url) {
  if (!pools.has(url)) pools.set(url, new pg.Pool({ connectionString: url, max: 5 }));
  return pools.get(url);
}

export function neon(url) {
  const p = pool(url);
  const sql = (strings, ...values) => {
    let text = strings[0];
    values.forEach((_, i) => { text += `$${i + 1}${strings[i + 1]}`; });
    const q = { text, values };
    q.run = (client) => (client || p).query(text, values).then((r) => r.rows);
    q.then = (ok, err) => q.run().then(ok, err);
    return q;
  };
  sql.transaction = async (queries) => {
    const client = await p.connect();
    try {
      await client.query('begin');
      const out = [];
      for (const q of queries) out.push(await q.run(client));
      await client.query('commit');
      return out;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };
  return sql;
}
