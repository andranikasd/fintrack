import { describe, expect, it } from 'vitest';
import { appendChannelExpense } from '../src/lib/channel-table';
import { parseDailyPost } from '../src/lib/daily-post';
const date=Date.parse('2026-09-15T08:00:00Z')/1000;
const tz='Asia/Yerevan';
describe('editing human-authored channel tables',()=>{
  it('preserves native table styles, rich text, savings and row order',()=>{
    const original={date,rich_message:{is_rtl:false,blocks:[
      {type:'heading',text:{type:'bold',text:'Sep 15'}},
      {type:'table',is_bordered:true,is_striped:true,cells:[
        [{text:'Item',is_header:true,align:'left'},{text:'price',is_header:true,align:'right'}],
        [{text:{type:'italic',text:'coffee @ Card'},align:'left'},{text:'200',align:'right'}],
        [{text:'save:Laptop @ Card',align:'left'},{text:'50.77',align:'right'}],
        [{text:'withdraw:Laptop @ Cash',align:'left'},{text:'20.77',align:'right'}],
      ]},
      {type:'paragraph',text:['Total: ',{type:'bold',text:'200'},' AMD']},
    ]}};
    const before=structuredClone(original);
    const result=appendChannelExpense(original,tz,'metro @ Card',150);
    const blocks=result.rich!.blocks as any[];
    expect(original).toEqual(before);
    expect(blocks[0]).toEqual(before.rich_message.blocks[0]);
    expect(blocks[1].cells.slice(0,4)).toEqual((before.rich_message.blocks[1] as any).cells);
    expect(blocks[1]).toMatchObject({is_bordered:true,is_striped:true});
    expect(blocks[1].cells[4][1]).toMatchObject({text:'150',align:'right',is_header:false});
    expect(blocks[2].text).toEqual(['Total: ',{type:'bold',text:'350'},' AMD']);
    expect(parseDailyPost({date,rich_message:result.rich},tz).warning).toBeNull();
  });
  it('inserts before a native total row and preserves its cell formatting',()=>{
    const result=appendChannelExpense({date,rich_message:{blocks:[{type:'table',cells:[[{text:'Item'},{text:'price'}],[{text:'coffee @ Card'},{text:'200'}],[{text:'Total',is_header:true},{text:{type:'bold',text:'200'},align:'right'}]]}]}},tz,'metro @ Card',150);
    const table=result.rich!.blocks![0] as any;
    expect(table.cells[2][0].text).toBe('metro @ Card');
    expect(table.cells[3][1]).toEqual({text:{type:'bold',text:'350'},align:'right'});
    expect(parseDailyPost({date,rich_message:result.rich},tz).rows).toHaveLength(2);
  });
  it('keeps Markdown tables and shifts Telegram formatting entities to the updated footer',()=>{
    const text='Sep 15\n| Item | price |\n|---|---|\n| coffee @ Card | 200 |\nTotal: 200 AMD';
    const entities=[{type:'bold' as const,offset:0,length:6},{type:'bold' as const,offset:text.indexOf('Total:'),length:14}];
    const result=appendChannelExpense({date,text,entities},tz,'metro @ Card',150);
    expect(result.text).toContain('| coffee @ Card | 200 |\n| metro @ Card | 150 |\nTotal: 350 AMD');
    expect(result.entities![0]).toEqual(entities[0]);
    expect(result.entities![1]!.offset).toBe(result.text!.indexOf('Total:'));
    expect(result.entities![1]!.length).toBe(14);
    expect(parseDailyPost({date,text:result.text},tz).warning).toBeNull();
  });
  it('inserts before a Markdown total row without changing its pipe style',()=>{
    const text='Sep 15\n| Item | price |\n| coffee @ Card | 200 |\n| Total | 200 |';
    const result=appendChannelExpense({date,text},tz,'metro @ Card',150);
    expect(result.text).toContain('| metro @ Card | 150 |\n| Total | 350 |');
    expect(parseDailyPost({date,text:result.text},tz).warning).toBeNull();
  });
  it('keeps caption messages as captions and refuses labels that would damage the table',()=>{
    const source={date,caption:'Item | price\ncoffee @ Card | 200\nTotal: 200'};
    expect(appendChannelExpense(source,tz,'metro @ Card',150).caption).toBe(true);
    expect(()=>appendChannelExpense(source,tz,'bad | item',150)).toThrow('pipe characters');
  });
});
