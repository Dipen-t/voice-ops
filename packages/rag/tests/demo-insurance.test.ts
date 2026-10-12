import { expect,it,vi } from 'vitest';
import type { Pool } from 'pg';
import { ingestInsuranceDemo } from '../src/demo-insurance.js';
// Fictional sample corpus, synthetic database and embedding fixtures; no hosted calls.
it('embeds an expanded corpus in bounded batches before replacing the previous index',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[]});const release=vi.fn();
  const connect=vi.fn().mockResolvedValue({query,release});
  const embed=vi.fn(async(texts:string[])=>{expect(texts.length).toBeLessThanOrEqual(8);return texts.map(()=>[1,...Array<number>(383).fill(0)]);});
  const result=await ingestInsuranceDemo({connect} as unknown as Pool,{key:'synthetic',embed,close:async()=>{}},new AbortController().signal);
  expect(result.chunks).toBeGreaterThan(16);expect(embed.mock.calls.length).toBeGreaterThan(2);
  expect(embed.mock.calls.flatMap(([texts])=>texts).some(t=>t.includes('Deductible versus co-payment'))).toBe(true);
  expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');expect(release).toHaveBeenCalledOnce();
});
it('leaves the previous database index intact if a later embedding batch fails',async()=>{
  const connect=vi.fn();let batches=0;
  const embed=vi.fn(async(texts:string[])=>{if(++batches===2)throw new Error('Synthetic embedding failure');return texts.map(()=>[1]);});
  await expect(ingestInsuranceDemo({connect} as unknown as Pool,{key:'synthetic',embed,close:async()=>{}},new AbortController().signal)).rejects.toThrow('Synthetic embedding failure');
  expect(connect).not.toHaveBeenCalled();
});
