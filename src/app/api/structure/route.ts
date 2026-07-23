import { NextRequest, NextResponse } from "next/server";

const aliases: Record<string,string> = {
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

type PubChemRecord = {
  id?:{id?:{cid?:number}};
  atoms?:{aid?:number[];element?:number[]};
  bonds?:{aid1?:number[];aid2?:number[];order?:number[]};
  coords?:Array<{aid?:number[];conformers?:Array<{x?:number[];y?:number[]}>}>;
};

async function pubchem(path:string) {
  const response=await fetch(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/${path}`,{
    headers:{Accept:"application/json"},
    next:{revalidate:60*60*24*7},
  });
  if(!response.ok)throw new Error(`PubChem returned ${response.status}`);
  return response.json();
}

export async function GET(request:NextRequest) {
  const formula=(request.nextUrl.searchParams.get("formula")??"").normalize("NFKC").replace(/\s+/g,"");
  if(!formula)return NextResponse.json({error:"Enter a molecular formula."},{status:400});
  try{
    let identity=aliases[formula];
    let cid:number|undefined;
    if(!identity){
      const search=await pubchem(`compound/fastformula/${encodeURIComponent(formula)}/cids/JSON?MaxRecords=2`) as {IdentifierList?:{CID?:number[]}};
      const matches=search.IdentifierList?.CID??[];
      if(matches.length!==1)return NextResponse.json({error:"That formula has multiple structural isomers in PubChem. Enter a recognized compound formula; no structure was guessed."},{status:409});
      cid=matches[0];
      identity=formula;
    }
    const data=await pubchem(`compound/${cid?`cid/${cid}`:`name/${encodeURIComponent(identity)}`}/JSON?record_type=2d`) as {PC_Compounds?:PubChemRecord[]};
    const record=data.PC_Compounds?.[0],coordinateSet=record?.coords?.[0],conformer=coordinateSet?.conformers?.[0];
    const aids=record?.atoms?.aid??[],atomicNumbers=record?.atoms?.element??[],coordinateAids=coordinateSet?.aid??[];
    if(!record||!aids.length||!conformer?.x||!conformer.y)throw new Error("PubChem returned no drawable conformer");
    const coordinateIndex=new Map(coordinateAids.map((aid,index)=>[aid,index]));
    const atoms=aids.map((aid,index)=>{
      const position=coordinateIndex.get(aid)??index;
      return{aid,atomicNumber:atomicNumbers[index],x:conformer.x![position],y:conformer.y![position]};
    });
    const bonds=(record.bonds?.aid1??[]).map((from,index)=>({from,to:record.bonds!.aid2![index],order:Math.max(1,Math.min(3,record.bonds!.order?.[index]??1))}));
    return NextResponse.json({cid:record.id?.id?.cid,name:aliases[formula]??identity,formula,atoms,bonds,source:"PubChem"});
  }catch(error){
    return NextResponse.json({error:error instanceof Error?error.message:"The structure could not be loaded."},{status:502});
  }
}
