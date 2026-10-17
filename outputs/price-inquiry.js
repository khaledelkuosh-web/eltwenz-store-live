(async function(){
  const id=decodeURIComponent(location.pathname.split('/').filter(Boolean).pop()||'');
  const loading=document.getElementById('loading'),card=document.getElementById('inquiryCard'),notFound=document.getElementById('notFound');
  try{
    const response=await fetch('/api/products/'+encodeURIComponent(id),{cache:'no-store'});
    const data=await response.json();
    if(!response.ok||!data.product)throw new Error('not-found');
    document.getElementById('productName').textContent=data.product.name;
    document.getElementById('productCategory').textContent=data.product.category;
    document.title='اسأل عن سعر '+data.product.name+' | Eltwenz Store';
    loading.hidden=true;card.hidden=false;
    const form=document.getElementById('inquiryForm'),button=document.getElementById('sendButton'),message=document.getElementById('formMessage');
    form.addEventListener('submit',async event=>{
      event.preventDefault();message.textContent='بنبعت الاستفسار...';button.disabled=true;
      const values=new FormData(form);
      try{
        const saved=await fetch('/api/price-inquiries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productId:id,name:String(values.get('name')||'').trim(),phone:String(values.get('phone')||'').trim(),message:String(values.get('message')||'').trim()})});
        const result=await saved.json();if(!saved.ok)throw new Error(result.error||'حصلت مشكلة في إرسال الاستفسار.');
        document.getElementById('inquiryId').textContent='رقم الاستفسار: '+result.id;
        card.hidden=true;document.getElementById('success').hidden=false;
      }catch(error){message.textContent=error.message;button.disabled=false}
    });
  }catch(_){loading.hidden=true;notFound.hidden=false}
})();
