export function createModelRegistry(connection, initialPlugins = []) {
  const plugins = [...initialPlugins];

  return {
    use(plugin) {
      if (typeof plugin !== "function")
        throw new Error("use: el plugin debe ser una función");
      plugins.push(plugin);
    },

    model(nombre, schema, coleccion) {
      // Idempotente: si el gateway monta el núcleo dos veces, no falla con OverwriteModelError.
      if (connection.models[nombre]) return connection.models[nombre];
      plugins.forEach((p) => schema.plugin(p));
      return connection.model(nombre, schema, coleccion);
    },
  };
}
