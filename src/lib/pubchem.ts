const elementSymbols=new Set("H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og".split(" "));

type PubChemRecord = {
  id?:{id?:{cid?:number}};
  atoms?:{aid?:number[];element?:number[]};
  bonds?:{aid1?:number[];aid2?:number[];order?:number[]};
  coords?:Array<{aid?:number[];conformers?:Array<{x?:number[];y?:number[]}>}>;
};

export type StructureCandidate={cid:number;name:string;formula:string};
export type StructureRecord={cid?:number;name:string;formula:string;source:string;atoms:Array<{aid:number;atomicNumber:number;x:number;y:number}>;bonds:Array<{from:number;to:number;order:number}>};
export type StructureResult={record?:StructureRecord;error?:string;candidates?:StructureCandidate[]};

const MAX_AGE=1000*60*60*24*7;

async function pubchem(path:string) {
  const key=`electron:pubchem:${path}`;
  try{
    const cached=localStorage.getItem(key);
    if(cached){
      const parsed=JSON.parse(cached) as {stored:number;data:unknown};
      if(Date.now()-parsed.stored<MAX_AGE)return parsed.data;
    }
  }catch{}
  let lastStatus=502;
  for(let attempt=0;attempt<2;attempt++){
    const response=await fetch(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/${path}`,{headers:{Accept:"application/json"}});
    if(response.ok){
      const data=await response.json();
      try{localStorage.setItem(key,JSON.stringify({stored:Date.now(),data}));}catch{}
      return data;
    }
    lastStatus=response.status;
    if(response.status<500&&response.status!==429)break;
  }
  throw new Error(`PubChem returned ${lastStatus}`);
}

export async function lookupStructure(query:string):Promise<StructureResult> {
  const raw=query.normalize("NFKC").trim(),compact=raw.replace(/\s+/g,"");
  if(!raw)return{error:"Enter a formula, compound name, PubChem CID, or prefixed SMILES."};
  try{
    const formulaTokens=[...compact.matchAll(/([A-Z][a-z]?)(\d*)/g)];
    const formula=formulaTokens.map((match)=>match[0]).join("")===compact&&formulaTokens.every((match)=>elementSymbols.has(match[1]))?compact:"";
    let cid:number|undefined,inputPath:string|undefined;
    const cidMatch=raw.match(/^(?:cid\s*:?\s*)?(\d+)$/i);
    if(cidMatch)cid=Number(cidMatch[1]);
    else if(/^smiles\s*:/i.test(raw))inputPath=`smiles/${encodeURIComponent(raw.replace(/^smiles\s*:/i,"").trim())}`;
    else if(!formula)inputPath=`name/${encodeURIComponent(raw)}`;
    else{
      const search=await pubchem(`compound/fastformula/${encodeURIComponent(formula)}/cids/JSON?MaxRecords=25`) as {IdentifierList?:{CID?:number[]}};
      const matches=search.IdentifierList?.CID??[];
      if(!matches.length)return{error:"PubChem has no structure for that formula."};
      if(matches.length>1){
        const candidates=await pubchem(`compound/cid/${matches.join(",")}/property/Title,MolecularFormula/JSON`) as {PropertyTable?:{Properties?:Array<{CID:number;Title?:string;MolecularFormula?:string}>}};
        return{error:"Choose the PubChem structure you mean.",candidates:(candidates.PropertyTable?.Properties??[]).map((item)=>({cid:item.CID,name:item.Title??`PubChem compound ${item.CID}`,formula:item.MolecularFormula??formula}))};
      }
      cid=matches[0];
    }
    if(!cid){
      const resolution=await pubchem(`compound/${inputPath!}/cids/JSON`) as {IdentifierList?:{CID?:number[]}};
      cid=resolution.IdentifierList?.CID?.[0];
      if(!cid)throw new Error("PubChem could not resolve that identifier");
    }
    const data=await pubchem(`compound/cid/${cid}/JSON?record_type=2d`) as {PC_Compounds?:PubChemRecord[]};
    const record=data.PC_Compounds?.[0],coordinateSet=record?.coords?.[0],conformer=coordinateSet?.conformers?.[0];
    const aids=record?.atoms?.aid??[],atomicNumbers=record?.atoms?.element??[],coordinateAids=coordinateSet?.aid??[];
    if(!record||!aids.length||!conformer?.x||!conformer.y)throw new Error("PubChem returned no drawable conformer");
    const coordinateIndex=new Map(coordinateAids.map((aid,index)=>[aid,index]));
    const atoms=aids.map((aid,index)=>{const position=coordinateIndex.get(aid)??index;return{aid,atomicNumber:atomicNumbers[index],x:conformer.x![position],y:conformer.y![position]};});
    const bonds=(record.bonds?.aid1??[]).map((from,index)=>({from,to:record.bonds!.aid2![index],order:Math.max(1,Math.min(3,record.bonds!.order?.[index]??1))}));
    const resolvedCid=record.id?.id?.cid;
    const properties=resolvedCid?await pubchem(`compound/cid/${resolvedCid}/property/Title,MolecularFormula/JSON`) as {PropertyTable?:{Properties?:Array<{Title?:string;MolecularFormula?:string}>}}:undefined;
    const property=properties?.PropertyTable?.Properties?.[0];
    return{record:{cid:resolvedCid,name:property?.Title??raw,formula:property?.MolecularFormula??formula,atoms,bonds,source:"PubChem"}};
  }catch(error){return{error:error instanceof Error?error.message:"The structure could not be loaded."};}
}
