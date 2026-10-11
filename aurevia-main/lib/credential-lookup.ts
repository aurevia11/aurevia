import {createHash,timingSafeEqual} from 'node:crypto';

export function resolveCredentialLookup(username:string,email:string,adminUsername:string|undefined,adminEmail:string|undefined,adminLogin=false){
  const normalizedUsername=username.trim().toLowerCase();
  const normalizedEmail=email.trim().toLowerCase();
  const normalizedAdminEmail=adminEmail?.trim().toLowerCase();
  const matchesAdminUsername=!!normalizedUsername&&!!adminUsername&&normalizedUsername===adminUsername.trim().toLowerCase();
  if(adminLogin)return {isAdminUsername:true,lookupEmail:matchesAdminUsername?normalizedAdminEmail:normalizedEmail||normalizedAdminEmail};
  const isAdminUsername=matchesAdminUsername;
  return {isAdminUsername,lookupEmail:isAdminUsername?normalizedAdminEmail:normalizedEmail};
}

export function matchesConfiguredAdminPassword(supplied:string,configured:string){
  if(!configured)return false;
  const suppliedHash=createHash('sha256').update(supplied).digest();
  const configuredHash=createHash('sha256').update(configured).digest();
  return timingSafeEqual(suppliedHash,configuredHash);
}
