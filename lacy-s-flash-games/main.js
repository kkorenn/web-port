const originalFetch = window.fetch;

let max = 0;
let done = 0;
function mergeFiles(fileParts) {
	return new Promise((resolve, reject) => {
		let buffers = [];

		function fetchPart(index) {
			if (index >= fileParts.length) {
				let mergedBlob = new Blob(buffers);
				let mergedFileUrl = URL.createObjectURL(mergedBlob);
				resolve(mergedFileUrl);
				return;
			}
			fetch(fileParts[index])
				.then((response) => response.arrayBuffer())
				.then((data) => {
					buffers.push(data);
					done = done+1;
					document.querySelector("#loading-text").textContent = `LOADING... (${done}/${max})`;
					fetchPart(index + 1);
				})
				.catch(reject);
		}
		fetchPart(0);
	});
}

function getParts(file, start, end) {
	let parts = [];
	for (let i = start; i <= end; i++) {
		parts.push(file + ".part" + i);
	}
	max = max+end;
	return parts;
}
Promise.all([
    mergeFiles(getParts("main.data", 1, 19)),
    mergeFiles(getParts("Lacey's Flash Games.wasm", 1, 2))
]).then(([dataurl, wasmUrl]) => {
    window.fetch = async function (url, ...args) {
        if (url.endsWith("main.data")) {
            return originalFetch(dataurl, ...args);
        } else if (url.endsWith("Lacey's Flash Games.wasm")) {
            return originalFetch(wasmUrl, ...args);
        } else {
            return originalFetch(url, ...args);
        }
    };
    window.hijsfdhjngfs();
});