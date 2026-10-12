import { z } from 'zod';

const text = z.string().min(1).max(600);
export const answerSchema = z.object({
  observed_evidence: z.array(z.object({ evidence_id:z.string().regex(/^E\d+$/), observation:text, quote:z.string().min(3).max(180) }).strict()).max(8),
  likely_explanations:z.array(z.object({ hypothesis:text, evidence_ids:z.array(z.string().regex(/^E\d+$/)).min(1).max(6) }).strict()).max(3),
  confidence:z.enum(['low','medium']),
  uncertainty:z.array(text).min(1).max(6),
  suggested_checks:z.array(text).max(6),
  documentation_ids:z.array(z.string().regex(/^D\d+$/)).max(5),
  clarification:z.string().max(600).nullable(),
}).strict();
export type Answer=z.infer<typeof answerSchema>;
export type Evidence={id:string;tool:string;arguments:Record<string,unknown>;data:Record<string,unknown>};
export type Citation={id:string;text:string;citation:Record<string,unknown>};
export type Event={sequence:number;type:string;at:string;elapsed_ms:number;data:Record<string,unknown>};
export class InvestigationFailure extends Error {constructor(public readonly code:string){super(code);}}
export function evidenceStrings(value:unknown):string[] {
  if(typeof value==='string')return [value];
  if(Array.isArray(value))return value.flatMap(evidenceStrings);
  if(value&&typeof value==='object')return Object.values(value).flatMap(evidenceStrings);
  return [];
}
export function validateAnswer(raw:string,evidence:Evidence[],citations:Citation[]):Answer {
  let answer:Answer;
  try {answer=answerSchema.parse(JSON.parse(raw));}catch{throw new InvestigationFailure('INVALID_MODEL_ANSWER');}
  const allowed=new Map(evidence.map(item=>[item.id,[JSON.stringify(item.data),...evidenceStrings(item.data)]]));
  for(const item of answer.observed_evidence) {
    if(!allowed.get(item.evidence_id)?.some(text=>text.includes(item.quote)))throw new InvestigationFailure('UNSUPPORTED_EVIDENCE_REFERENCE');
    const numbers:string[]=item.observation.match(/\b\d+(?:\.\d+)?\b/g)??[];
    const quotedNumbers:string[]=item.quote.match(/\b\d+(?:\.\d+)?\b/g)??[];
    if(numbers.some(number=>!quotedNumbers.includes(number)))throw new InvestigationFailure('UNSUPPORTED_NUMERIC_OBSERVATION');
  }
  for(const hypothesis of answer.likely_explanations)if(hypothesis.evidence_ids.some(id=>!allowed.has(id)))throw new InvestigationFailure('UNSUPPORTED_EVIDENCE_REFERENCE');
  if(answer.documentation_ids.some(id=>!citations.some(c=>c.id===id)))throw new InvestigationFailure('UNSUPPORTED_DOCUMENT_REFERENCE');
  if(!answer.observed_evidence.length&&answer.likely_explanations.length)throw new InvestigationFailure('UNSUPPORTED_EXPLANATION');
  return answer;
}
