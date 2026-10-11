export function resolveCredentialLookup(username:string,email:string,adminUsername:string|undefined,adminEmail:string|undefined,adminLogin=false){
  const normalizedUsername=username.trim().toLowerCase();
  const normalizedEmail=email.trim().toLowerCase();
  const matchesAdminUsername=!!normalizedUsername&&!!adminUsername&&normalizedUsername===adminUsername.trim().toLowerCase();
  if(adminLogin)return {isAdminUsername:true,lookupEmail:matchesAdminUsername?adminEmail:normalizedEmail||adminEmail};
  const isAdminUsername=matchesAdminUsername;
  return {isAdminUsername,lookupEmail:isAdminUsername?adminEmail:email};
}
