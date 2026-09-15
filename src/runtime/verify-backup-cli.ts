import { resolve } from 'node:path';
import { verifyBackup } from './verify-backup';

const source=process.argv[2];
if(!source){console.error('Usage: npm run backup:verify -- /path/to/snapshot.sqlite');process.exitCode=1;}
else {
  try {console.log(JSON.stringify(await verifyBackup(resolve(source),process.env.MIGRATIONS_DIR||'migrations'),null,2));}
  catch(error){console.error('Backup verification failed:',error instanceof Error?error.message:'Unknown error');process.exitCode=1;}
}
