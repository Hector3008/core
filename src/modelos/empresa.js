import mongoose from "mongoose";
import { marcarGlobal } from "../tenancy.js";

export const empresaSchema = marcarGlobal(
  new mongoose.Schema(
    {
      nombre: { type: String, required: true, trim: true },
      slug: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
      },
      activa: { type: Boolean, default: true },
      // País de la empresa (ISO de 2 letras). Fija el código telefónico por defecto de sus clientes.
      // Las empresas anteriores a este campo no lo tienen: se asume PE (ver telefono.js).
      pais: { type: String, default: "PE", uppercase: true, trim: true },
      // Moneda de los precios del catálogo (ISO 4217 de 3 letras). Las empresas anteriores al campo asumen PEN.
      moneda: { type: String, default: "PEN", uppercase: true, trim: true },
      // Opciones de seguridad que ajusta cada empresa. Los valores por defecto y los límites
      // viven en auth/pin-config.js (no en el esquema) para validarlos con mensajes claros.
      seguridad: {
        pin: {
          habilitado: Boolean,
          largoMin: Number,
          largoMax: Number,
          maxIntentos: Number,
          bloqueoMin: Number,
          inactividadMin: Number,
          sesionMaxHoras: Number,
          codigoVigenciaMin: Number,
        },
      },
      // Reglas de puntos de la empresa (ver fidelizacion/config.js). Sin tocar: habilitada, 1 punto por unidad.
      fidelizacion: {
        habilitada: Boolean,
        puntosPorUnidad: Number,
        // Niveles por puntos acumulados (5.30): de menor a mayor
        niveles: [{ _id: false, nombre: String, desde: Number }],
      },
      // Marca visible en la carta pública (5.33): logo (URL https), eslogan y tres colores (#rrggbb).
      // La validación y la paleta derivada viven en marca.js.
      marca: {
        logo: String,
        eslogan: String,
        colorPrincipal: String,
        colorSecundario: String,
        colorFondo: String,
      },
      // Datos que salen impresos en los comprobantes (5.34). Validación en datos-empresa.js.
      datos: {
        razonSocial: String,
        idFiscal: String,
        direccion: String,
        telefono: String,
        pie: String,
      },
      servicios: [
        {
          _id: false,
          codigo: { type: String, required: true },
          activa: { type: Boolean, default: true },
        },
      ],
    },
    { timestamps: true },
  ),
);
