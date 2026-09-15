import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
export async function buildDailyChart(rows: Array<{day:string;spent:number;saved:number;withdrawn:number}>,today:string): Promise<Uint8Array> {
  const doc=await PDFDocument.create();
  const font=await doc.embedFont(StandardFonts.Helvetica);
  const bold=await doc.embedFont(StandardFonts.HelveticaBold);
  for(let offset=0;offset<rows.length;offset+=30) {
    const data=rows.slice(offset,offset+30), page=doc.addPage([842,595]);
    const text=(s:string,x:number,y:number,size=10,strong=false)=>page.drawText(s,{x,y,size,font:strong?bold:font,color:rgb(.13,.17,.23)});
    text('Daily spending & savings',40,548,23,true);
    text(`${data[0]!.day} to ${data.at(-1)!.day} | AMD`,40,523,11);
    text('Blue: expenses   Green: savings deposits   Orange: withdrawals',40,497,11);
    const colors=[rgb(.2,.44,.85),rgb(.16,.65,.45),rgb(.92,.52,.13)];
    const max=Math.max(...data.flatMap(r=>[r.spent,r.saved,r.withdrawn]),1), bottom=160, height=290, width=710;
    for(let i=0;i<=4;i++) {
      const y=bottom+height*i/4;
      page.drawLine({start:{x:65,y},end:{x:775,y},color:rgb(.86,.88,.9),thickness:.5});
      text(String(Math.round(max*i/4)),15,y-3,8);
    }
    const slot=width/data.length;
    data.forEach((r,i)=> {
      [r.spent,r.saved,r.withdrawn].forEach((value,j)=>page.drawRectangle({x:65+i*slot+slot*.1+j*slot*.26,y:bottom,width:slot*.23,height:value/max*height,color:colors[j]}));
      if(i%Math.max(1,Math.ceil(data.length/15))===0) text(r.day.slice(5),65+i*slot,bottom-17,8);
    });
    text(`Expenses: ${data.reduce((s,r)=>s+r.spent,0).toLocaleString('en-US')} AMD`,40,105,12,true);
    text(`Saved: ${data.reduce((s,r)=>s+r.saved,0).toLocaleString('en-US',{maximumFractionDigits:2})} AMD`,300,105,12,true);
    text(`Withdrawn: ${data.reduce((s,r)=>s+r.withdrawn,0).toLocaleString('en-US',{maximumFractionDigits:2})} AMD`,550,105,12,true);
    text(`${today} is incomplete. Empty dates mean no entries recorded, not verified zero spending.`,40,65,10);
    text('Savings deposits are transfers, not expenses. Opening savings balances are excluded.',40,48,10);
  }
  return doc.save();
}
