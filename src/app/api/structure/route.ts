import { NextRequest, NextResponse } from "next/server";

const aliases: Record<string,string> = {
  C20H25N3O:"lysergic acid diethylamide",
  C22H28N2O:"fentanyl",
  ClNa:"sodium chloride",
  NaCl:"sodium chloride",
  CO2:"carbon dioxide",
  H2O:"water",
  CH4:"methane",
  H3N:"ammonia",
  NH3:"ammonia",
  ClH:"hydrogen chloride",
  CO:"carbon monoxide",
  O2:"oxygen",
  N2:"nitrogen",
  H2:"hydrogen",
  Cl2:"chlorine",
  C2H6:"ethane",
  C2H4:"ethene",
  C2H2:"ethyne",
  H2O2:"hydrogen peroxide",
  O3:"ozone",
  O2S:"sulfur dioxide",
  SO2:"sulfur dioxide",
  O3S:"sulfur trioxide",
  SO3:"sulfur trioxide",
  CaCl2:"calcium chloride",
  Cl2Mg:"magnesium chloride",
  MgCl2:"magnesium chloride",
  Fe2O3:"iron(III) oxide",
  Na2O:"sodium oxide",
  C6H6:"benzene",
};
const preferredNames:Record<string,string>={
  C20H25N3O:"LSD (lysergic acid diethylamide)",
  C22H28N2O:"fentanyl",
};
const nameAliases:Record<string,string>={
  lsd:"lysergic acid diethylamide",
};
const knownCids:Record<string,number>={
  lsd:5761,
};
const elementSymbols=new Set("H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og".split(" "));

type PubChemRecord = {
  id?:{id?:{cid?:number}};
  atoms?:{aid?:number[];element?:number[]};
  bonds?:{aid1?:number[];aid2?:number[];order?:number[]};
  coords?:Array<{aid?:number[];conformers?:Array<{x?:number[];y?:number[]}>}>;
};

const CACHE_SECONDS=60*60*24*7;
const CACHE_HEADERS={"Cache-Control":`public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS*4}`};

async function pubchem(path:string) {
  let lastStatus=502;
  for(let attempt=0;attempt<2;attempt++){
    const response=await fetch(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/${path}`,{
      headers:{Accept:"application/json"},
      cache:"force-cache",
      next:{revalidate:CACHE_SECONDS,tags:["pubchem-structures"]},
    });
    if(response.ok)return response.json();
    lastStatus=response.status;
    if(response.status<500&&response.status!==429)break;
  }
  throw new Error(`PubChem returned ${lastStatus} for ${path.split("?")[0]}`);
}

export async function GET(request:NextRequest) {
  const raw=(request.nextUrl.searchParams.get("query")??request.nextUrl.searchParams.get("formula")??"").normalize("NFKC").trim();
  const compact=raw.replace(/\s+/g,"");
  if(!raw)return NextResponse.json({error:"Enter a formula, compound name, PubChem CID, or prefixed SMILES."},{status:400});
  try{
    const formulaTokens=[...compact.matchAll(/([A-Z][a-z]?)(\d*)/g)];
    const formula=formulaTokens.map((match)=>match[0]).join("")===compact&&formulaTokens.every((match)=>elementSymbols.has(match[1]))?compact:"";
    let identity=formula?aliases[formula]:nameAliases[raw.toLowerCase()];
    let cid:number|undefined=knownCids[raw.toLowerCase()];
    let inputPath:string|undefined;
    const cidMatch=raw.match(/^(?:cid\s*:?\s*)?(\d+)$/i);
    if(cidMatch)cid=Number(cidMatch[1]);
    else if(/^smiles\s*:/i.test(raw))inputPath=`smiles/${encodeURIComponent(raw.replace(/^smiles\s*:/i,"").trim())}`;
    else if(!formula)inputPath=`name/${encodeURIComponent(identity??raw)}`;
    else if(!identity&&!cid){
      const search=await pubchem(`compound/fastformula/${encodeURIComponent(formula)}/cids/JSON?MaxRecords=2`) as {IdentifierList?:{CID?:number[]}};
      const matches=search.IdentifierList?.CID??[];
      if(matches.length!==1)return NextResponse.json({error:"That formula matches multiple PubChem structures. Enter its compound name, PubChem CID, or smiles: followed by SMILES."},{status:409,headers:{"Cache-Control":"public, s-maxage=3600"}});
      cid=matches[0];
    }
    if(!cid){
      const resolution=await pubchem(`compound/${inputPath??`name/${encodeURIComponent(identity!)}`}/cids/JSON`) as {IdentifierList?:{CID?:number[]}};
      cid=resolution.IdentifierList?.CID?.[0];
      if(!cid)throw new Error("PubChem could not resolve that identifier");
    }
    const data=await pubchem(`compound/cid/${cid}/JSON?record_type=2d`) as {PC_Compounds?:PubChemRecord[]};
    const record=data.PC_Compounds?.[0],coordinateSet=record?.coords?.[0],conformer=coordinateSet?.conformers?.[0];
    const aids=record?.atoms?.aid??[],atomicNumbers=record?.atoms?.element??[],coordinateAids=coordinateSet?.aid??[];
    if(!record||!aids.length||!conformer?.x||!conformer.y)throw new Error("PubChem returned no drawable conformer");
    const coordinateIndex=new Map(coordinateAids.map((aid,index)=>[aid,index]));
    const atoms=aids.map((aid,index)=>{
      const position=coordinateIndex.get(aid)??index;
      return{aid,atomicNumber:atomicNumbers[index],x:conformer.x![position],y:conformer.y![position]};
    });
    const bonds=(record.bonds?.aid1??[]).map((from,index)=>({from,to:record.bonds!.aid2![index],order:Math.max(1,Math.min(3,record.bonds!.order?.[index]??1))}));
    const resolvedCid=record.id?.id?.cid;
    const properties=resolvedCid?await pubchem(`compound/cid/${resolvedCid}/property/Title,MolecularFormula/JSON`) as {PropertyTable?:{Properties?:Array<{Title?:string;MolecularFormula?:string}>}}:undefined;
    const property=properties?.PropertyTable?.Properties?.[0],resolvedFormula=property?.MolecularFormula??formula;
    return NextResponse.json({cid:resolvedCid,name:preferredNames[resolvedFormula]??property?.Title??identity??raw,formula:resolvedFormula,atoms,bonds,source:"PubChem"},{headers:CACHE_HEADERS});
  }catch(error){
    return NextResponse.json({error:error instanceof Error?error.message:"The structure could not be loaded."},{status:502,headers:{"Cache-Control":"no-store"}});
  }
}
