const axios = require('axios');
const config = require('../routes/config');
const { attachObiexAuth } = require('../utils/obiexAuth');

const obiexAxios = axios.create({
  baseURL: config.obiex.baseURL.replace(/\/+$/, ''),
});
obiexAxios.interceptors.request.use(attachObiexAuth);

async function getAvailableNetworks(currency) {
  const response = await obiexAxios.get(`/currencies/${currency.toUpperCase()}/networks`);
  return response.data.map(n => n.network);
}

module.exports = { getAvailableNetworks };
