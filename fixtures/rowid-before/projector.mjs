export function project(row,fields){const selected={};for(const name of fields)if(Object.hasOwn(row,name))selected[name]=row[name];return selected;}
