// Isolated acceptance receiver. This is Anthropic HTTP protocol data, never model inference.
import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
if(!['ticket10','ticket11'].includes(process.env.ATOMIC_ISOLATION_EXPERIMENT??''))throw new Error('experiment_only');
let modelCalls=0,businessWrites=0;
const server=createServer({key:await readFile('/cert/model.key'),cert:await readFile('/cert/model.crt')},async(req,res)=>{
 if(req.method==='GET'&&req.url==='/counts'){res.end(JSON.stringify({modelCalls,businessWrites}));return;}
 if(req.method!=='POST'||req.url!=='/v1/messages'){businessWrites++;res.writeHead(403).end();return;}
 const parts=[];for await(const p of req)parts.push(p);const input=JSON.parse(Buffer.concat(parts).toString());
 modelCalls++;if(input.model!=='controlled-model'||req.headers['x-api-key']!=='SYNTHETIC_MODEL_KEY'){res.writeHead(403).end();return;}
 if(process.env.ATOMIC_ISOLATION_EXPERIMENT==='ticket11'&&JSON.stringify(input.messages).includes('deadline-ticket11'))return;
 const malicious=JSON.stringify(input.messages).includes('attack-ticket10');
 const fileTask=JSON.stringify(input.messages).includes('file-positive-ticket10');
 const research=JSON.stringify(input.messages).includes('research-positive-ticket10');
 const alreadyDenied=JSON.stringify(input.messages).includes('tool_result');
 const tool=(malicious||fileTask||research)&&!alreadyDenied;
 const text=research?JSON.stringify({summary:'Controlled protocol transport check',conclusions:[{kind:'unknown',statement:'This receiver does not perform research reasoning.',citations:[]}]}):fileTask?JSON.stringify({summary:'Processed 1 rows',input_count:1,valid_count:1,rejected_count:0,total:'3',groups:{a:'3'}}):'{"summary":"controlled protocol","value":3}';
 res.writeHead(200,{'content-type':'text/event-stream'});
 const event=(type:string,data:unknown)=>res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
 event('message_start',{type:'message_start',message:{id:`msg_${modelCalls}`,type:'message',role:'assistant',model:'controlled-model',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}});
 for(let index=0;index<(tool&&research?2:1);index++){
  event('content_block_start',{type:'content_block_start',index,content_block:tool?{type:'tool_use',id:'toolu_controlled_'+index,name:research?'mcp__research__read_source':'Bash',input:{}}:{type:'text',text:''}});
  event('content_block_delta',{type:'content_block_delta',index,delta:tool?{type:'input_json_delta',partial_json:JSON.stringify(research?{source_id:index===0?'opensandbox':'sandcastle'}:{command:malicious?'touch /workspace/forbidden-write':'node /opt/atomicagent/dist/src/process-data.js'})}:{type:'text_delta',text}});
  event('content_block_stop',{type:'content_block_stop',index});
 }
 event('message_delta',{type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:12}});event('message_stop',{type:'message_stop'});res.end();
});
server.listen(443,'0.0.0.0');
