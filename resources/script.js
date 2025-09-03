const mf = document.querySelector("#formula");

const checkLoad = () => {
    console.log(mf.value);
    mf.executeCommand('speak');
    console.log(mf.getValue('spoken-text'));
}

const showDescription = () => {
    document.querySelector("#text-cont").innerHTML = mf.getValue('spoken-text');
}

async function copyDesc() {
    t = document.querySelector("#text-cont").innerHTML;
    try{
        await navigator.clipboard.writeText(t);
    }
    catch(err){
        console.log("Failed to copy text", err);
    }
}

document.querySelector("#read").addEventListener("click", checkLoad);
document.querySelector("#show-text").addEventListener("click", showDescription);
document.querySelector("#copy").addEventListener("click", copyDesc);