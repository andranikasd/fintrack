import { expect } from 'vitest';
import type { Update } from 'grammy/types';
import { createBot } from '../src/bot';
import { todayIn } from '../src/lib/dates';
import { testDb } from './sqlite';

export const tz='Asia/Yerevan',day=todayIn(tz);
export async function fixture(channel=false) {
  const {db,d1}=testDb();await db.ensureUser(1);await db.ensureUser(2);
  await db.accounts.create(1,'Card',100000,'2000-01-01','card');
  await db.accounts.create(1,'Cash',50000,'2000-01-01','cash');
  await db.accounts.create(2,'Other',100000,'2000-01-01','other');
  if(channel)await db.finance.link(-1001,1,'Diary');
  const bot=createBot({DB:d1,BOT_TOKEN:'test',BOT_INFO:JSON.stringify({id:99,is_bot:true,first_name:'Test',username:'test_bot'}),ALLOWED_USER_IDS:'1,2',DEFAULT_TZ:tz,CURRENCY:'AMD',CURRENCY_SIGN:'֏',WEBHOOK_SECRET:'test',DASHBOARD_URL:'https://example.com'},{waitUntil:()=>{}});
  const calls:Array<{method:string;payload:any}>=[];
  let sequence=100,revision=Math.floor(Date.now()/1000);
  bot.api.config.use(async(_next,method,payload)=>{
    calls.push({method,payload});const p=payload as any;
    if(p.chat_id===-1001&&(method==='sendRichMessage'||method==='editMessageText'))return {ok:true,result:{message_id:77,date:revision,edit_date:++revision,chat:{id:-1001,type:'channel',title:'Diary'},...(p.rich_message?{rich_message:p.rich_message}:{text:p.text,entities:p.entities})}} as never;
    return {ok:true,result:true} as never;
  });
  const command=async(text:string,user=1)=>bot.handleUpdate({update_id:sequence++,message:{message_id:sequence,date:revision,from:{id:user,is_bot:false,first_name:'User'},chat:{id:user,type:'private'},text,...(text.startsWith('/')?{entities:[{type:'bot_command',offset:0,length:text.split(' ')[0]!.length}]}:{})}} as Update);
  const tap=async(data:string,user=1)=>bot.handleUpdate({update_id:sequence++,callback_query:{id:String(sequence),from:{id:user,is_bot:false,first_name:'User'},chat_instance:'x',data,message:{message_id:99,date:revision,chat:{id:user,type:'private'},text:'Previous step'}}} as Update);
  const buttons=()=>calls.filter(c=>c.payload.reply_markup).at(-1)!.payload.reply_markup.inline_keyboard.flat() as Array<{text:string;callback_data:string}>;
  const click=async(label:string)=>{const b=buttons().find(b=>b.text===label);expect(b,JSON.stringify(buttons())).toBeDefined();await tap(b!.callback_data);};
  const draft=async()=> (await db.getState(1))!.payload as any;
  const action=async(action:string)=>{const d=await draft();await tap(`draft:${d.request.replaceAll('-','')}:${action}`);};
  return {db,d1,bot,calls,command,tap,buttons,click,draft,action};
}

