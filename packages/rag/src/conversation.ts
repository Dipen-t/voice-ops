// Shared, bounded conversational fast path. No model, retrieval or provider dependencies.
export function smallTalk(text:string):{reply:string;covered:false;citations:[]}|undefined {
  if(text.length>500)return undefined;
  const s=text.normalize('NFKC').toLowerCase().replace(/[\p{P}]/gu,' ').replace(/\s+/g,' ').trim();
  let reply:string|undefined;
  if(/^(hello|hi|hey|namaste|namaskar|नमस्ते|नमस्कार|हेलो|हाय)(\s+(जी|ji))?$/.test(s))reply='Namaste! Main Sahaayak hoon. Insurance ke confusing terms ko aasaan language mein samajhte hain. Aap premium, coverage ya claim process ke baare mein poochh sakte hain. Batayein, kaise help karoon?';
  else if(/^(thanks|thank you|धन्यवाद|शुक्रिया|shukriya)$/.test(s))reply='Aapka swagat hai! Aur koi sawaal ho toh aaraam se poochhiye.';
  else if(/^(how are you|कैसे हो|कैसी हो|कैसे हैं आप|आप कैसी हैं|आप कैसे हैं|kaise ho|aap kaise hain)$/.test(s))reply='Main help karne ke liye ready hoon! Aap kaise hain? Chahein toh sample insurance document par baat kar sakte hain.';
  else if(/^(bye|goodbye|अलविदा|बाय)$/.test(s))reply='Phir milenge! Baatcheet khatam karne ke liye neeche wala button daba sakte hain.';
  else if(/^(?:(?:achha|accha|acha|अच्छा|theek(?: hai)?|thik(?: hai)?|ठीक(?: है)?|ok(?:ay)?|ओके|haan|han|हाँ|हां|ji|जी|samajh (?:gaya|gayi|aa gaya|aa gayi|aaya)|समझ (?:गया|गई|आ गया|आ गई)|समझ में आ गया|got it|understood|clear(?: hai)?|thanks|thank you|shukriya|शुक्रिया|धन्यवाद)(?:\s+|$))+$/u.test(s))reply=/samajh|समझ|got it|understood/u.test(s)?'Badhiya! Aur koi sawaal ho toh poochhiye.':'Ji, theek hai.';
  return reply?{reply,covered:false,citations:[]}:undefined;
}
