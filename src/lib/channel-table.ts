import type { InputRichMessage, MessageEntity, RichText } from 'grammy/types';
import { parseDailyPost, richText } from './daily-post';

type SourcePost = { date:number; text?:string; caption?:string; entities?:MessageEntity[]; caption_entities?:MessageEntity[]; rich_message?:unknown };
type Block = Record<string, any>;
const totalPattern=/^(\s*\|?\s*(?:total\s*[:|]?\s*)?)([\d,.]+)(\s*(?:֏|AMD)?\s*\|?\s*)$/i;

/** Replace a text range while retaining the rich text wrappers around it. */
function replaceRich(value:RichText,start:number,end:number,replacement:string):RichText {
  let offset=0,inserted=false;
  const visit=(part:RichText):RichText=>{
    if(typeof part==='string') {
      const from=offset;offset+=part.length;
      if(offset<=start || from>=end)return part;
      const prefix=part.slice(0,Math.max(0,start-from));
      const suffix=part.slice(Math.max(0,end-from));
      const middle=inserted?'':replacement;inserted=true;
      return prefix+middle+suffix;
    }
    if(Array.isArray(part))return part.map(visit);
    if('text' in part)return {...part,text:visit(part.text)};
    return part;
  };
  return visit(value);
}
function updateTotal(block:Block,total:number):boolean {
  if(block.text===undefined)return false;
  const plain=richText(block.text),match=totalPattern.exec(plain);
  if(!match)return false;
  block.text=replaceRich(block.text,match[1]!.length,match[1]!.length+match[2]!.length,String(total));
  return true;
}

/** Append to the actual source, preserving existing rows, formatting and order. */
export function appendChannelExpense(source:SourcePost,tz:string,label:string,amount:number):{rich?:InputRichMessage;text?:string;entities?:MessageEntity[];caption?:boolean} {
  if(/[|\r\n]/.test(label))throw new Error('Use an item and account name without pipe characters or line breaks.');
  const parsed=parseDailyPost(source,tz);
  const total=parsed.rows.filter(r=>r.kind==='expense').reduce((sum,r)=>sum+r.amountMinor/100,amount);
  if(source.rich_message) {
    const rich=structuredClone(source.rich_message) as {blocks:Block[]};
    const tables=rich.blocks.filter(b=>b.type==='table');
    const table=tables.at(-1);
    if(table) {
      const cells=table.cells as Block[][];
      const footer=cells.findIndex(row=>/^(total)?$/i.test(richText(row[0]!.text).trim()) && /^[\d,.]+(?:\s*(?:AMD|֏))?$/i.test(richText(row[1]!.text).trim()));
      const template=cells.find(row=>!row.some(c=>c.is_header)&&! /^(item|description|expense|total)$/i.test(richText(row[0]!.text).trim())) ?? cells[0]!;
      const makeCell=(value:string,index:number)=>({...template[index],text:value,is_header:false});
      if(footer>=0) updateTotal(cells[footer]![1]!,total);
      cells.splice(footer>=0?footer:cells.length,0,[makeCell(label,0),makeCell(String(amount),1)]);
    } else {
      const footer=rich.blocks.findIndex(b=>b.text!==undefined&&totalPattern.test(richText(b.text)));
      rich.blocks.splice(footer>=0?footer:rich.blocks.length,0,{type:'paragraph',text:`${label} | ${amount}`});
    }
    for(const block of rich.blocks) if(block.type!=='table')updateTotal(block,total);
    const result={rich:rich as InputRichMessage};
    parseDailyPost({...source,rich_message:result.rich},tz);
    return result;
  }
  let text=source.text??source.caption??'';
  let entities=structuredClone(source.entities??source.caption_entities??[]);
  const lines=text.split('\n');
  const totalIndex=lines.findIndex(line=>totalPattern.test(line));
  let closing=-1;
  lines.forEach((line,index)=>{if(/^\s*```\s*$/.test(line))closing=index;});
  const insertionLine=totalIndex>=0?totalIndex:closing>0?closing:lines.length;
  const pipeStyle=lines.some(line=>/^\s*\|.*\|\s*$/.test(line));
  const row=pipeStyle?`| ${label} | ${amount} |`:`${label} | ${amount}`;
  const edits:Array<{start:number;end:number;value:string}>=[];
  if(totalIndex>=0) {
    const line=lines[totalIndex]!,match=totalPattern.exec(line)!;
    const start=lines.slice(0,totalIndex).reduce((n,line)=>n+line.length+1,0)+match[1]!.length;
    edits.push({start,end:start+match[2]!.length,value:String(total)});
  }
  const insertion=lines.slice(0,insertionLine).reduce((n,line)=>n+line.length+1,0);
  edits.push(insertionLine===lines.length?{start:text.length,end:text.length,value:`\n${row}`}:{start:insertion,end:insertion,value:`${row}\n`});
  for(const edit of edits.sort((a,b)=>b.start-a.start||b.end-a.end)) {
    const delta=edit.value.length-(edit.end-edit.start);
    entities=entities.map(entity=>{
      const start=entity.offset,end=start+entity.length;
      if(start>=edit.end)return {...entity,offset:start+delta};
      if(end<=edit.start)return entity;
      const nextStart=Math.min(start,edit.start);
      const nextEnd=end>=edit.end?end+delta:edit.start+edit.value.length;
      return {...entity,offset:nextStart,length:nextEnd-nextStart};
    }).filter(entity=>entity.length>0);
    text=text.slice(0,edit.start)+edit.value+text.slice(edit.end);
  }
  parseDailyPost({text,date:source.date},tz);
  return {text,entities,caption:source.text===undefined};
}
