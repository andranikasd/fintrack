import { Db } from '../src/db';
import { SqliteDatabase } from '../src/runtime/sqlite';

/** Exercise the production adapter, including actual migrations and atomic batches. */
export function testDb() {
  const d1 = new SqliteDatabase(':memory:');
  d1.migrate('migrations');
  return { db: new Db(d1, 'Asia/Yerevan'), d1 };
}
