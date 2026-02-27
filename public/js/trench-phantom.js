// trench-phantom.js - Phantom wallet connect + sign for Trench Warfare
// Requires: Solana web3.js loaded before this script (CDN or bundle)
// Phantom extension: window.phantom.solana

(function() {
  function base64ToUint8Array(base64) {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function uint8ArrayToBase64(uint8Array) {
    var binary = '';
    for (var i = 0; i < uint8Array.length; i++) binary += String.fromCharCode(uint8Array[i]);
    return btoa(binary);
  }

  async function connect() {
    var provider = window.phantom && window.phantom.solana;
    if (!provider) throw new Error('Phantom not installed. Get it at phantom.app');
    var resp = await provider.connect();
    return resp.publicKey ? resp.publicKey.toString() : null;
  }

  async function signAndSendTransaction(serializedBase64) {
    var provider = window.phantom && window.phantom.solana;
    if (!provider) throw new Error('Phantom not installed');
    var solanaWeb3 = window.solanaWeb3 || window['@solana/web3.js'];
    if (!solanaWeb3) throw new Error('Solana web3.js not loaded. Add script before trench-phantom.js');

    var bytes = base64ToUint8Array(serializedBase64);
    var tx;
    try {
      if (solanaWeb3.VersionedTransaction) {
        tx = solanaWeb3.VersionedTransaction.deserialize(bytes);
      } else {
        tx = solanaWeb3.Transaction.from(bytes);
      }
    } catch (e) {
      tx = solanaWeb3.Transaction.from(bytes);
    }

    var signed = await provider.signTransaction(tx);
    var serialized = signed.serialize ? signed.serialize() : signed.serializeMessage ? signed.serializeMessage() : null;
    if (!serialized) throw new Error('Could not serialize signed transaction');
    var arr = serialized.buffer ? new Uint8Array(serialized) : serialized;
    return uint8ArrayToBase64(arr);
  }

  window.TrenchPhantom = { connect: connect, signAndSendTransaction: signAndSendTransaction };
})();
