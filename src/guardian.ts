import { request } from 'node:http';
import { TaskError, type Run } from './domain.js';
export interface GuardianPort { register(run:Run):Promise<void>; observation():Promise<unknown> }
// Private, local control capability. Never mounted into task containers or selectable by a Run.
export class GuardianClient implements GuardianPort {
 constructor(private socketPath:string,private guardianId:string){}
 private call(path:string,input?:unknown):Promise<unknown>{return new Promise((resolve,reject)=>{
  const body=input===undefined?undefined:JSON.stringify(input);
  const req=request({socketPath:this.socketPath,path,method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(body?{'Content-Length':Buffer.byteLength(body)}:{})}},res=>{let content='';res.on('data',chunk=>{content+=String(chunk);if(content.length>32768)req.destroy();});res.on('end',()=>{try{if(res.statusCode!==200)throw new Error();resolve(JSON.parse(content));}catch{reject(new TaskError('provisioning_failed'));}});});
  req.setTimeout(3000,()=>req.destroy());req.on('error',()=>reject(new TaskError('provisioning_failed')));req.end(body);
 });}
 async register(run:Run){await this.call('/register',{guardian_id:this.guardianId,run_id:run.run_id,operation_id:run.allocation!.operation_id,deadline_at:run.manifest.deadline_at,image:run.manifest.profile.image});}
 observation(){return this.call('/health');}
 get id(){return this.guardianId;}
}
