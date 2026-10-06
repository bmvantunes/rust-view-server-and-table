import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Demonstration } from "../demonstration";
export const Route = createFileRoute("/")({ component: Home });
function Home() {
  const [mounted,setMounted]=useState(false);
  useEffect(()=>setMounted(true),[]);
  return mounted?<Demonstration/>:<main><h1>BrunoTable · two live views</h1><p>Opening local workspace…</p></main>;
}
