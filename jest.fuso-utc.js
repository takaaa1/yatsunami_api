/**
 * Os testes rodam em UTC, como o contentor de produção.
 *
 * A máquina de desenvolvimento fica em Brasília; sem isto, código que usa o
 * fuso do processo (`new Date(ano, mes, 1)`, `getMonth()`) passava nos testes
 * por coincidência e errava em produção. O `globalSetup` roda antes de os
 * workers subirem, que herdam o `TZ` (verificação do review, D2).
 */
module.exports = () => {
  process.env.TZ = 'UTC';
};
