import { describe, expect, it } from 'vitest';
import { createBot } from '../src/bot';
import { todayIn } from '../src/lib/dates';
import { testDb } from './sqlite';

describe('native Telegram financial replies', () => {
  it('renders key reports as native tables and immediately offers categories for new spending', async () => {
    const {db,d1}=testDb(); await db.ensureUser(1);
    const day=todayIn('Asia/Yerevan');
    await db.accounts.create(1,'Card <main>',100000000,day,'card');
    await db.income.add(1,'Salary & bonus',100000,day,'salary',1);
    await db.finance.putGoal(1,'Laptop',10000000,null,10000,0,null);
    await db.addTransaction(1,null,150,'coffee & pastry',day,1);
    const bot=createBot({DB:d1,BOT_TOKEN:'test',BOT_INFO:JSON.stringify({id:99,is_bot:true,first_name:'Test',username:'test'}),ALLOWED_USER_IDS:'1',DEFAULT_TZ:'Asia/Yerevan',CURRENCY:'AMD',CURRENCY_SIGN:'֏',WEBHOOK_SECRET:'test'},{waitUntil:()=>{}});
    const calls:Array<{method:string;payload:any}>=[];
    bot.api.config.use(async(_next,method,payload)=>{calls.push({method,payload});return {ok:true,result:true} as never;});
    let id=0;
    const send=async(text:string)=>bot.handleUpdate({update_id:++id,message:{message_id:id,date:Math.floor(Date.now()/1000),from:{id:1,is_bot:false,first_name:'Owner'},chat:{id:1,type:'private',first_name:'Owner'},text,...(text.startsWith('/')?{entities:[{type:'bot_command' as const,offset:0,length:text.split(' ')[0]!.length}]}:{})}});
    for(const command of ['/accounts','/income','/today','/week','/month','/stats','/last','/goal']) {
      calls.length=0;await send(command);
      const report=calls.find(c=>c.method==='sendRichMessage');
      expect(report,command).toBeDefined();
      expect(report!.payload.rich_message.blocks.some((b:any)=>b.type==='table'),command).toBe(true);
      expect(JSON.stringify(calls)).not.toContain('Could not complete this request');
    }
    calls.length=0;await send('200 mysterious item @ Card <main>');
    expect(calls.some(c=>c.method==='sendRichMessage')).toBe(true);
    const prompt=calls.find(c=>c.payload.text?.includes('Which category fits'));
    expect(prompt?.payload.reply_markup.inline_keyboard.flat().some((b:any)=>b.callback_data.startsWith('review:set:'))).toBe(true);
    expect(prompt?.payload.reply_markup.inline_keyboard.flat().some((b:any)=>b.callback_data.startsWith('review:new:'))).toBe(true);
    await send('/undo');
    expect(await db.totalBetween(1,day,day)).toBe(150);
  });
});
