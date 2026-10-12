import { randomBytes } from 'node:crypto';
import { writeFile,readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const defaults={PORT:'3002',INVESTIGATOR_ENABLED:'true',API_BEARER_TOKEN:randomBytes(24).toString('hex'),GROQ_API_KEY:'',GROQ_MODEL:'openai/gpt-oss-20b',MODEL_REQUESTS_ENABLED:'false',SARVAM_API_KEY:'',VOICE_REQUESTS_ENABLED:'false'};
try {
  const old=parseEnv(await readFile('.env.model','utf8'));
  if(old.API_BEARER_TOKEN)console.log('Existing investigator configuration preserved');
  else throw new Error('EXISTING_CONFIGURATION_NEEDS_MANUAL_REVIEW');
} catch(error) {
  // eslint-disable-next-line preserve-caught-error -- Original diagnostic might contain configuration secrets.
  if(!(error instanceof Error&&'code' in error&&error.code==='ENOENT'))throw new Error('Investigator configuration exists; preserve it and add missing fields manually');
  await writeFile('.env.model',Object.entries(defaults).map(([key,value])=>`${key}=${value}`).join('\n')+'\n',{mode:0o600});
  console.log('Ignored .env.model created. Model requests disabled until configured; no secret is printed.');
}
