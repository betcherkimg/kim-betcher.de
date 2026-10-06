/* German date entry, with the existing ISO fields retained for storage and calendars. */
(function(){
  "use strict";
  var valueProperty = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");

  function parseDate(text){
    text = text.trim();
    if(!text) return "";
    var day, month, year, match;
    if((match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text))){
      year = +match[1]; month = +match[2]; day = +match[3];
    }else if((match = /^(\d{2})(\d{2})(\d{2}|\d{4})$/.exec(text))){
      day = +match[1]; month = +match[2]; year = +match[3];
      if(match[3].length === 2) year += year < 50 ? 2000 : 1900;
    }else if((match = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(text))){
      day = +match[1]; month = +match[2]; year = +match[3];
      if(match[3].length === 2) year += year < 50 ? 2000 : 1900;
    }else return null;
    var date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    if(year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return String(year).padStart(4,"0") + "-" + String(month).padStart(2,"0") + "-" + String(day).padStart(2,"0");
  }

  function displayDate(iso){
    return iso ? iso.slice(8,10) + "." + iso.slice(5,7) + "." + iso.slice(0,4) : "";
  }

  document.querySelectorAll('input[type="date"]').forEach(function(native, index){
    var wrapper = document.createElement("div");
    wrapper.className = "date-field";
    native.before(wrapper);
    wrapper.appendChild(native);
    native.classList.add("date-native");
    native.tabIndex = -1;
    native.setAttribute("aria-hidden","true");

    var input = document.createElement("input");
    input.type = "text";
    input.className = "date-display";
    input.id = (native.id || "date-" + index) + "-eingabe";
    input.placeholder = "tt.mm.jjjj / ttmmjj";
    input.inputMode = "numeric";
    input.autocomplete = "off";
    input.maxLength = 10;
    input.required = native.required;
    input.disabled = native.disabled;
    input.readOnly = native.readOnly;
    ["aria-label","aria-describedby"].forEach(function(attr){
      if(native.hasAttribute(attr)) input.setAttribute(attr,native.getAttribute(attr));
    });
    if(native.id) document.querySelectorAll('label[for="' + native.id + '"]').forEach(function(label){ label.htmlFor = input.id; });
    if(!native.id && native.parentElement.closest(".field")){
      var label = native.parentElement.closest(".field").querySelector("label");
      if(label && !label.htmlFor) label.htmlFor = input.id;
    }
    wrapper.appendChild(input);
    var button = document.createElement("button");
    button.type = "button";
    button.className = "date-calendar";
    button.setAttribute("aria-label","Kalender öffnen");
    button.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3" stroke="currentColor" stroke-width="1.6"/><path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    wrapper.appendChild(button);

    function validate(){
      var iso = parseDate(input.value), error = "";
      if(iso === null) error = "Bitte ein gültiges Datum eingeben, z. B. 091226 oder 09.12.2026.";
      else if(iso && native.min && iso < native.min) error = "Das Datum darf nicht vor dem " + displayDate(native.min) + " liegen.";
      else if(iso && native.max && iso > native.max) error = "Das Datum darf nicht nach dem " + displayDate(native.max) + " liegen.";
      input.setCustomValidity(error);
      native.setCustomValidity(error);
      return iso;
    }
    function syncDisplay(){
      input.value = displayDate(valueProperty.get.call(native));
      validate();
    }
    function syncNative(format){
      var iso = validate();
      valueProperty.set.call(native,iso || "");
      if(format && iso) input.value = displayDate(iso);
    }
    Object.defineProperty(native,"value",{
      configurable:true,
      get:function(){ return valueProperty.get.call(native); },
      set:function(value){ valueProperty.set.call(native,value); syncDisplay(); }
    });
    native.focus = function(options){ input.focus(options); };
    native.addEventListener("invalid",function(event){
      event.preventDefault(); input.focus(); input.reportValidity();
    });
    input.addEventListener("input",function(){ syncNative(false); native.dispatchEvent(new Event("input",{bubbles:true})); });
    input.addEventListener("change",function(){ syncNative(true); native.dispatchEvent(new Event("change",{bubbles:true})); });
    // Keep an invalid entry visible so it can be corrected, even after a change event.
    native.addEventListener("change",function(event){ if(event.isTrusted) syncDisplay(); });
    input.addEventListener("blur",function(){ syncNative(true); });
    button.addEventListener("click",function(){
      if(typeof native.showPicker === "function"){
        try{ native.showPicker(); return; }catch(error){}
      }
      input.focus();
    });
    new MutationObserver(function(){
      input.required = native.required; input.disabled = native.disabled; input.readOnly = native.readOnly;
      button.disabled = native.disabled || native.readOnly;
      validate();
    }).observe(native,{attributes:true,attributeFilter:["min","max","required","disabled","readonly"]});
    if(native.form) native.form.addEventListener("reset",function(){ queueMicrotask(syncDisplay); });
    syncDisplay();
  });
})();
