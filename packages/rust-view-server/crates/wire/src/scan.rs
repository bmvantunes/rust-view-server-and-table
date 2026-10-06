use super::*;
struct Scan<'a>{b:&'a[u8],p:usize,n:usize,finite_floats:bool}
impl<'a> Scan<'a>{
 fn take(&mut self,n:usize)->R<&'a[u8]>{let e=self.p.checked_add(n).ok_or("length overflow")?;if e>self.b.len(){return Err("truncated".into())}let s=&self.b[self.p..e];self.p=e;Ok(s)}
 fn byte(&mut self)->R<u8>{Ok(self.take(1)?[0])}
 fn be(&mut self,n:usize)->R<u64>{Ok(self.take(n)?.iter().fold(0,|x,b|(x<<8)|u64::from(*b)))}
 fn var(&mut self)->R<u64>{let mut v=0u64;for i in 0..10{let b=self.byte()?;if i==9&&b>1{return Err("varint overflow".into())}v|=u64::from(b&127)<<(i*7);if b<128{if i>0&&b==0{return Err("overlong varint".into())}return Ok(v)}}Err("overlong varint".into())}
 fn len(&mut self)->R<usize>{usize::try_from(self.var()?).map_err(|_|"length".into())}
 fn text(&mut self,n:usize)->R<()>{std::str::from_utf8(self.take(n)?).map_err(|_|"UTF8")?;Ok(())}
 fn pb(&mut self,end:usize,kind:u8,d:usize)->R<()>{
  if kind==0{budget(d,&mut self.n)?}else if kind==3{budget(d+1,&mut self.n)?}let mut seen=0u16;let mut count=0;
  while self.p<end{let tag=self.var()?;let f=(tag>>3) as usize;let wire=tag&7;
   if kind==0{if !(1..=8).contains(&f)||seen!=0{return Err("unknown/conflicting variant".into())}seen=1;
    if f<=3{if wire!=0{return Err("wire type".into())}let v=self.var()?;if f<=2&&v>1{return Err("bool".into())}}
    else{if wire!=2{return Err("wire type".into())}let len=self.len()?;let stop=self.p.checked_add(len).ok_or("length")?;if stop>end{return Err("declared length".into())}
     match f{4=>self.text(len)?,5=>{self.take(len)?;},8=>{if len>MAX_EXACT+1{return Err("exact bytes".into())}self.take(len)?;},6=>self.pb(stop,1,d)?,7=>self.pb(stop,2,d)?,_=>unreachable!()}}
   }else if kind==1||kind==2{if f!=1||wire!=2{return Err("unknown repeated field".into())}count+=1;if count>MAX_COLLECTION{return Err("collection".into())}let len=self.len()?;let stop=self.p.checked_add(len).ok_or("length")?;if stop>end{return Err("declared length".into())}self.pb(stop,if kind==1{0}else{3},if kind==1{d+1}else{d})?;
   }else{if !(1..=2).contains(&f)||wire!=2||seen&(1<<f)!=0{return Err("entry field".into())}seen|=1<<f;let len=self.len()?;let stop=self.p.checked_add(len).ok_or("length")?;if stop>end{return Err("declared length".into())}if f==1{self.text(len)?}else{self.pb(stop,0,d+1)?}}
   if self.p>end{return Err("submessage boundary".into())}
  }
  if self.p!=end||(kind==0&&seen==0)||(kind==3&&seen&4==0){return Err("missing variant/value".into())}Ok(())
 }
 fn mp(&mut self,d:usize,key:bool)->R<()>{budget(d,&mut self.n)?;let c=self.byte()?;if key&&!((0xa0..=0xbf).contains(&c)||[0xd9,0xda,0xdb].contains(&c)){return Err("key type".into())}
  match c{
   0x00..=0x7f|0xe0..=0xff|0xc0|0xc2|0xc3=>{},
   0xcc..=0xcf|0xd0..=0xd3=>{let signed=c>=0xd0;let width=1usize<<(c-if signed{0xd0}else{0xcc});let raw=self.be(width)?;let v=if signed{let shift=64-width*8;((raw<<shift) as i64)>>shift}else{0};if if signed{v>= -32||(width>1&&v>= -(1i64<<(width/2*8-1)))}else{raw<if width==1{128}else{1u64<<(width/2*8)}}{return Err("overlong integer".into())}},
   0xcb if self.finite_floats=>{let v=f64::from_bits(self.be(8)?);if !v.is_finite(){return Err("nonfinite number".into())}},
   0xa0..=0xbf=>self.text((c&31) as usize)?,
   0xd9|0xda|0xdb=>{let w=1usize<<(c-0xd9);let n=self.be(w)? as usize;if (w==1&&n<32)||(w>1&&n<(1usize<<(w/2*8))){return Err("overlong string".into())}self.text(n)?},
   0xc4|0xc5|0xc6=>{let w=1usize<<(c-0xc4);let n=self.be(w)? as usize;if w>1&&n<(1usize<<(w/2*8)){return Err("overlong binary".into())}self.take(n)?;},
   0xc7|0xc8|0xc9|0xd4..=0xd8=>{let n=if c>=0xd4{1usize<<(c-0xd4)}else{self.be(1usize<<(c-0xc7))? as usize};if (c<0xd4&&[1,2,4,8,16].contains(&n))||(c==0xc8&&n<256)||(c==0xc9&&n<65536){return Err("overlong extension".into())}if n>MAX_EXACT+1{return Err("extension length".into())}if self.byte()!=Ok(42){return Err("extension id".into())}self.take(n)?;},
   0x90..=0x9f|0x80..=0x8f|0xdc|0xdd|0xde|0xdf=>{let map=c<=0x8f||c>=0xde;let n=if c<0xa0{(c&15)as usize}else{self.be(if c==0xdc||c==0xde{2}else{4})? as usize};if c>=0xdc&&(n<16||([0xdd,0xdf].contains(&c)&&n<65536)){return Err("overlong collection".into())}if n>MAX_COLLECTION||n*(if map{2}else{1})>self.b.len()-self.p{return Err("collection length".into())}for _ in 0..n{if map{self.mp(d+1,true)?;}self.mp(d+1,false)?;}},
   _=>return Err("unsupported marker/float".into())
  }Ok(())
 }
}
pub fn preflight_pb(b:&[u8])->R<()>{if b.is_empty()||b.len()>MAX_FRAME{return Err("frame budget".into())}Scan{b,p:0,n:0,finite_floats:false}.pb(b.len(),0,0)}
pub fn preflight_mp(b:&[u8])->R<()>{if b.is_empty()||b.len()>MAX_FRAME{return Err("frame budget".into())}let mut s=Scan{b,p:0,n:0,finite_floats:false};s.mp(0,false)?;if s.p!=b.len(){return Err("trailing bytes".into())}Ok(())}

pub fn preflight_generic_mp(b:&[u8])->R<()>{if b.is_empty()||b.len()>MAX_FRAME{return Err("frame budget".into())}let mut s=Scan{b,p:0,n:0,finite_floats:true};s.mp(0,false)?;if s.p!=b.len(){return Err("trailing bytes".into())}Ok(())}
