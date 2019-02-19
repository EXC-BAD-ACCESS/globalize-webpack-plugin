"use strict";

const CommonJsRequireDependency = require("webpack/lib/dependencies/CommonJsRequireDependency");
const ConcatSource = require("webpack-sources").ConcatSource;
const GlobalizeCompilerHelper = require("./GlobalizeCompilerHelper");
const MultiEntryPlugin = require("webpack/lib/MultiEntryPlugin");
const NormalModuleReplacementPlugin = require("webpack/lib/NormalModuleReplacementPlugin");
const NullDependency = require("webpack/lib/dependencies/NullDependency");
const PatchedRawModule = require("./PatchedRawModule");
const PrefixSource = require("webpack-core/lib/PrefixSource");
const SkipAMDPlugin = require("skip-amd-webpack-plugin");
const util = require("./util");

/**
* Prerender Mode:
* - Have Globalize modules replaced with their runtime modules.
* - Statically extracts formatters and parsers from user code and pre-compile
*   them into globalize-compiled-data chunks.
*/
class PrerenderModePlugin {
  constructor(attributes) {
    this.cldr = attributes.cldr || util.cldr;
    this.developmentLocale = attributes.developmentLocale;
    this.messages = attributes.messages && attributes.supportedLocales.reduce((sum, locale) => {
      sum[locale] = util.readMessages(attributes.messages, locale) || {};
      return sum;
    }, {});
    this.moduleFilter = util.moduleFilterFn(attributes.moduleFilter);
    this.supportedLocales = attributes.supportedLocales;
    this.output = attributes.output;
    this.timeZoneData = attributes.timeZoneData || util.timeZoneData;
    const tmpdirBase = attributes.tmpdirBase || ".";
    this.tmpdir = util.tmpdir(tmpdirBase);
  }

  apply(compiler) {
    const globalizeSkipAMDPlugin = new SkipAMDPlugin(/(^|[\/\\])globalize($|[\/\\])/);
    const normalModuleReplacementPlugin = new NormalModuleReplacementPlugin(/(^|[\/\\])globalize$/, "globalize/dist/globalize-runtime");
    const globalizeRuntimeskipAMDPlugin = new SkipAMDPlugin(/(^|[\/\\])globalize-runtime($|[\/\\])/);
    const output = this.output || "i18n-[locale].js";
    const globalizeCompilerHelper = new GlobalizeCompilerHelper({
      cldr: this.cldr,
      developmentLocale: this.developmentLocale,
      messages: this.messages,
      timeZoneData: this.timeZoneData,
      tmpdir: this.tmpdir,
      webpackCompiler: compiler
    });

    // Skip AMD part of Globalize Runtime UMD wrapper.
    globalizeSkipAMDPlugin.apply(compiler);

    // Replaces `require("globalize")` with `require("globalize/dist/globalize-runtime")`.
    normalModuleReplacementPlugin.apply(compiler);

    // Skip AMD part of Globalize Runtime UMD wrapper.
    globalizeRuntimeskipAMDPlugin.apply(compiler);

    const bindParser = (parser) => {
      // Map each AST and its request filepath.
      parser.hooks.program.tap("GlobalizePlugin", (ast) => {
        globalizeCompilerHelper.setAst(parser.state.current.request, ast);
      });

      // Precompile formatters & parsers from modules that `require("globalize")`.
      parser.hooks.call
        .for("require")
        .tap("GlobalizePlugin", (expr) => {
          if (expr.arguments.length !== 1) {
            return;
          }
          const param = parser.evaluateExpression(expr.arguments[0]);
          const request = parser.state.current.request;
          if (param.isString() && param.string === "globalize" && this.moduleFilter(request) &&
            !(globalizeCompilerHelper.isCompiledDataModule(request))) {

            // (a) Extract Globalize formatters & parsers, then create a custom
            //     precompiled formatters & parsers module.
            // (b) Add a dependency to the precompiled module. Note
            //     `require("globalize")` doesn't get replaced by `require(<custom
            //     precompiled module>)` because we do NOT `return true` here (as
            //     intended).
            //
            // Why to iterate over all the locales? Webpack allocates distinct
            // moduleIds per locale, enabling multiple locales to be used at the
            // same time.
            this.supportedLocales.forEach((locale) => {
              /* a */
              const compiledDataFilepath = globalizeCompilerHelper.createCompiledDataModule(request, locale);

              // Skip the AMD part of the custom precompiled formatters/parsers UMD
              // wrapper.
              //
              // Note: We're hacking an already created SkipAMDPlugin instance instead
              // of using a regular code like the below in order to take advantage of
              // its position in the plugins list. Otherwise, it'd be too late to plugin
              // and AMD would no longer be skipped at this point.
              //
              // compiler.apply(new SkipAMDPlugin(new RegExp(compiledDataFilepath));
              //
              // 1: Removes the leading and the trailing `/` from the regexp string.
              globalizeSkipAMDPlugin.requestRegExp = new RegExp([
                globalizeSkipAMDPlugin.requestRegExp.toString().slice(1, -1)/* 1 */,
                util.escapeRegex(compiledDataFilepath)
              ].join("|"));

              /* b */
              const dep = new CommonJsRequireDependency(compiledDataFilepath, null);
              dep.loc = expr.loc;
              dep.optional = !!parser.scope.inTry;
              parser.state.current.addDependency(dep);
            });
          }
        });
    };

    // Create globalize-compiled-data chunks for the supportedLocales.
    compiler.hooks.entryOption.tap("GlobalizePlugin", (context) => {
      this.supportedLocales.forEach((locale) => {
        const multiEntryPlugin = new MultiEntryPlugin(context, [], "globalize-compiled-data-" + locale);
        multiEntryPlugin.apply(compiler);
      });
    });

    compiler.plugin("this-compilation", (compilation) => {
      compilation.plugin("after-optimize-chunks", (chunks) => {
        var hasAnyModuleBeenIncluded;
        var compiledDataChunks = chunks.filter(function(chunk) {
          return /globalize-compiled-data/.test(chunk.name);
        });

        var modulesToMove = [];
        chunks.forEach(function(chunk) {
          chunk.getModules().forEach(function(module) {
            if (module.request && util.isGlobalizeRuntimeModule(module.request, [])) {
              modulesToMove.push({chunk: chunk, module: module});
            }
          });
        });
        modulesToMove.forEach(function(item) {
  	    compiledDataChunks.forEach(function(compiledDataChunk) {
            compiledDataChunk.addModule(item.module);
            item.module.addChunk(compiledDataChunk);
          });
  	    item.module.removeChunk(item.chunk);
        });

        chunks.forEach(function(chunk) {
          chunk.getModules().forEach(function(module) {
            if (globalizeCompilerHelper.isCompiledDataModule(module.request)) {
              hasAnyModuleBeenIncluded = true;
              module.removeChunk(chunk);
              compiledDataChunks.forEach(function(compiledDataChunk) {
                compiledDataChunk.addModule(module);
                module.addChunk(compiledDataChunk);
              });
            }
          });
        });
        compiledDataChunks.forEach(function(chunk) {
          var locale = chunk.name.replace("globalize-compiled-data-", "");
          chunk.filenameTemplate = output.replace("[locale]", locale);
        });
        if(!hasAnyModuleBeenIncluded) {
          console.warn("No Globalize compiled data module found");
        }
      });


      // Have each globalize-compiled-data chunks include precompiled data for
      // each supported locale. In each chunk, merge all the precompiled modules
      // into a single one. Finally, allow the chunks to be loaded incrementally
      // (not mutually exclusively). Details below.
      //
      // Up to this step, all globalize-compiled-data chunks include several
      // precompiled modules, which have been mandatory to allow webpack to figure
      // out the Globalize runtime dependencies. But for the final chunk we need
      // something a little different:
      //
      // a) Instead of including several individual precompiled modules, it's
      //    better (i.e., reduced size due to less boilerplate and due to deduped
      //    formatters and parsers) having one single precompiled module for all
      //    these individual modules.
      //
      // b) globalize-compiled-data chunks shouldn't be mutually exclusive to each
      //    other, but users should be able to load two or more of these chunks
      //    and be able to switch from one locale to another dynamically during
      //    runtime.
      //
      //    Some background: by having each individual precompiled module defining
      //    the formatters and parsers for its individual parents, what happens is
      //    that each parent will load the globalize precompiled data by its id
      //    with __webpack_require__(id). These ids are equally defined by the
      //    globalize-compiled-data chunks (each chunk including data for a
      //    certain locale). When one chunk is loaded, these ids get defined by
      //    webpack. When a second chunk is loaded, these ids would get
      //    overwritten.
      //
      //    Therefore, instead of having each individual precompiled module
      //    defining the formatters and parsers for its individual parents, we
      //    actually simplify them by returning Globalize only. The precompiled
      //    content for the whole set of formatters and parsers are going to be
      //    included in the entry module of each of these chunks.
      //    So, we accomplish what we need: have the data loaded as soon as the
      //    chunk is loaded, which means it will be available when each
      //    individual parent code needs it.

      compilation.hooks.afterOptimizeModuleIds.tap("GlobalizePlugin", () => {
        const globalizeModuleIds = [];
        const globalizeModuleIdsMap = {};

        compilation.chunks.forEach((chunk) => {
          for (const module of chunk.modulesIterable) {
            if (module.request && util.isGlobalizeRuntimeModule(module.request, [])) {
              // While request has the full pathname, aux has something like "globalize/dist/globalize-runtime/date".
              var aux = module.request.split(/[\/\\]/);
              aux = aux.slice(aux.lastIndexOf("globalize")).join("/").replace(/\.js$/, "");

              let moduleId = module.id;
              if (typeof moduleId === "string") {
                moduleId = JSON.stringify(moduleId);
              }

              globalizeModuleIds.push(moduleId);
              globalizeModuleIdsMap[aux] = moduleId;
            }
          }
        });

        compilation.moduleTemplate.plugin("render", function(moduleSource, module, chunk) {
          if(/globalize-compiled-data/.test(chunk.name) && !module.request) {

            // hack? to convince the webpack into adding __webpack_require__ to the function arg list
            module.addDependency(new NullDependency());

            var locale = chunk.name.replace("globalize-compiled-data-", "");
            var source = globalizeCompilerHelper.compile(locale)
            .replace("typeof define === \"function\" && define.amd", "false")
            .replace(/require\("([^)]+)"\)/g, function(garbage, moduleName) {
              return "__webpack_require__(" + globalizeModuleIdsMap[moduleName] + ")";
            });

            source = "(function(module, exports, __webpack_require__) {" + source + "})"

            return new PrefixSource(this.outputOptions.sourcePrefix || "", source);
          } else if (globalizeCompilerHelper.isCompiledDataModule(module.request)) {
            var newSource = "(function(module, exports, __webpack_require__) {module.exports = __webpack_require__(" + globalizeModuleIds[0] + ");})";
            return new PrefixSource(this.outputOptions.sourcePrefix || "", newSource);
          }

          return moduleSource;
        });
      });
    });

    compiler.hooks.normalModuleFactory.tap("GlobalizePlugin", factory => {
      factory.hooks.parser.for("javascript/auto").tap("GlobalizePlugin", bindParser);
    });

    compiler.plugin("compilation", (compilation, params) => {
      compilation.mainTemplate.plugin("render", function(bootstrapSource, chunk) {
        if(!/globalize-compiled-data/.test(chunk.name)) {
          var source = new ConcatSource();
          source.add("(function(localeFile) {\nreturn ");
          var replace = bootstrapSource.source().replace(/var Globalize = __webpack_require__[^;]+/g,"var Globalize = require(localeFile)");
          source.add(replace);
          source.add("\n})");
          return source;
        }

        return bootstrapSource;
      });
    });
  }
}

module.exports = PrerenderModePlugin;
