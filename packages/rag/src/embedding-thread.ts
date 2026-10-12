import { parentPort } from 'node:worker_threads';
import { resolve } from 'node:path';
import { env, pipeline } from '@huggingface/transformers';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = resolve('data/models').replaceAll('\\','/') + '/';
env.useFSCache = false;
const extractor = await pipeline('feature-extraction','Xenova/all-MiniLM-L6-v2',{ dtype:'q8', device:'cpu', session_options:{intraOpNumThreads:2,interOpNumThreads:1} });
parentPort!.on('message', async (texts:string[]) => {
  try {
    for (const text of texts) {
      const encoded = await extractor.tokenizer(text,{truncation:false,padding:false});
      if (encoded.input_ids.dims.at(-1)! > 256) throw new Error('TOKEN_LIMIT');
    }
    const result = await extractor(texts,{pooling:'mean',normalize:true});
    parentPort!.postMessage({vectors:result.tolist()});
  } catch { parentPort!.postMessage({error:'EMBEDDING_FAILED'}); }
});
