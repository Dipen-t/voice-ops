import { expect,it } from 'vitest';
import { DocumentModel,smallTalk,validateDocumentReply,unknownReply,insuranceSearchQuery } from '../src/document-model.js';
import { loadConfig } from '../src/config/env.js';
// Explicitly fictional document/model fixtures; no provider calls.
const sources=[{id:'D1',text:'Fictional waiting period is 30 days.',citation:{title:'Synthetic FAQ'}}];
it('normalizes Hindi and Hinglish topics locally while leaving ambiguous follow-ups to translation',()=>{
  expect(insuranceSearchQuery('Deductible aur co-payment ka difference?')).toBe('deductible co-payment');
  expect(insuranceSearchQuery('प्रीमियम क्या होता है?')).toContain('premium');
  expect(insuranceSearchQuery('वेटिंग पीरियड कितना है?')).toContain('waiting period');
  expect(insuranceSearchQuery('Aur iska example do')).toBeUndefined();
  expect(insuranceSearchQuery('Is weather nice today?')).toBeUndefined();
});
it('greets and responds to thanks without a model or document claims',()=>{expect(smallTalk('नमस्ते!')?.reply).toContain('Namaste');expect(smallTalk('Namaste')?.reply).toEqual(smallTalk('नमस्ते!')?.reply);expect(smallTalk('hello')?.covered).toBe(false);expect(smallTalk('शुक्रिया')?.reply).toContain('swagat');expect(smallTalk('Waiting period?')).toBeUndefined();});
it('acknowledges repeated Hindi and Hinglish phrases without swallowing a real question',()=>{
  for(const text of ['अच्छा ठीक है, ठीक है, समझ गया।','ठीक है।','समझ गई','Achha, theek hai, samajh gaya!','Okay, got it.','Haan ji','theek hai shukriya']){
    const reply=smallTalk(text);expect(reply).toBeDefined();expect(reply!.reply.length).toBeLessThan(100);expect(reply!.citations).toEqual([]);
  }
  for(const text of ['अच्छा ठीक है, premium kitna hai?','Theek hai lekin samajh nahi aaya','Samajh gaya, claim kaise karoon?','Aur example do','Okay '.repeat(120)])expect(smallTalk(text)).toBeUndefined();
});
it('requires actual quotes and rejects unsupported amounts',()=>{expect(()=>validateDocumentReply({reply:'सैंपल में 30 दिन हैं।',covered:true,citations:[{id:'D1',quote:'30 days'}]},sources)).not.toThrow();expect(()=>validateDocumentReply({reply:'90 दिन',covered:true,citations:[{id:'D1',quote:'30 days'}]},sources)).toThrow('UNSUPPORTED_DOCUMENT_NUMBER');expect(()=>validateDocumentReply({reply:'तीस दिन',covered:true,citations:[{id:'D2',quote:'30 days'}]},sources)).toThrow('INVALID_DOCUMENT_CITATION');expect(()=>validateDocumentReply({reply:'Covered',covered:true,citations:[]},sources)).toThrow('UNGROUNDED_DOCUMENT_REPLY');});
it('withholds model claims when it marks the documents insufficient',()=>{expect(validateDocumentReply({reply:'Unknown but here is a guess',covered:false,citations:[]},[])).toEqual(unknownReply);});
it('checks whole numeric values and accepts formatting only for sourced worked examples',()=>{
  const example=[{id:'D1',text:'Fictional example: Rs.5000 deductible on Rs.12000 leaves Rs.7000.',citation:{}}];
  expect(()=>validateDocumentReply({reply:'Example mein Rs.5,000 deductible hai.',covered:true,citations:[{id:'D1',quote:example[0]!.text}]},example)).not.toThrow();
  expect(()=>validateDocumentReply({reply:'Example mein Rs.500 deductible hai.',covered:true,citations:[{id:'D1',quote:example[0]!.text}]},example)).toThrow('UNSUPPORTED_DOCUMENT_NUMBER');
});
it('retains several turns for follow-up explanations and validates longer grounded replies',async()=>{
  const reply='Is sample mein waiting period 30 days hai. '+('Yeh example sirf sample policy ko samajhne ke liye hai. '.repeat(13));
  const history=['premium question','premium reply','waiting question','waiting reply','example question','example reply'];
  let sent:Record<string,unknown>|undefined;
  const request:typeof fetch=async(_url,options)=>{
    sent=JSON.parse(String(options?.body));
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({reply,covered:true,citations:[{id:'D1',quote:'30 days'}]})}}]});
  };
  const model=new DocumentModel(loadConfig({DATABASE_URL:'postgres://localhost/synthetic',REDIS_URL:'redis://localhost',GROQ_API_KEY:'synthetic-only'}),request);
  expect((await model.answer('Aur explain karo',history,sources,new AbortController().signal)).reply).toBe(reply);
  const messages=sent!.messages as {content:string}[];
  expect(JSON.parse(messages[1]!.content).history).toEqual(history);
  expect(()=>validateDocumentReply({reply:'x'.repeat(1001),covered:true,citations:[{id:'D1',quote:'30 days'}]},sources)).toThrow();
});
