# Reaction source coverage

The application distinguishes reported reactions from predictions. Atom balancing verifies
conservation only; it does not establish that a reaction occurs.

## Included in the static index

| Source                 | Coverage                                                                                                                        | License                                                       | Imported data                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| Open Reaction Database | Organic synthesis, medicinal chemistry, patents, experimental procedures                                                        | CC BY-SA 4.0                                                  | Structured reactants, products, and ORD provenance        |
| Rhea                   | Curated biochemical and enzyme-catalyzed reactions                                                                              | CC BY 4.0                                                     | Directed reaction SMILES and Rhea identifiers             |
| Cantera mechanisms     | Combustion, gas-phase kinetics, electrochemistry, and surface mechanisms represented by the mechanisms distributed with Cantera | Mechanism-specific open data; Cantera is BSD-3-Clause         | Elementary reactions, reversibility, mechanism provenance |
| USGS PHREEQC databases | Aqueous acid-base chemistry, ion complexation, redox, mineral dissolution/precipitation, exchange, and surface chemistry        | U.S. government distribution with upstream-source attribution | Equilibrium equations and database provenance             |

PubChem remains the authority for compound identity, structures, formulas, names, and CIDs.

## Useful sources that cannot simply be bundled

| Source                                                 | Coverage                                                                | Reason not bundled                                                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| NIST Chemistry WebBook SRD 69                          | Thermochemistry for more than 9,000 reactions and combustion properties | Search-oriented copyrighted Standard Reference Data; no open bulk redistribution endpoint                                                     |
| NIST Chemical Kinetics Database                        | Thermal gas-phase kinetics                                              | Public search interface, but no documented redistributable bulk feed                                                                          |
| SABIO-RK                                               | Biochemical kinetic laws and conditions                                 | API access and licensing require separate review; its own documentation warns that a material fraction of structure identifiers are incorrect |
| RMG database                                           | Gas-phase reaction families, kinetics, and mechanism generation         | A reaction generator rather than a finite reactant-pair record set; requires a dedicated prediction pipeline                                  |
| MetaNetX                                               | Reconciled biochemical reactions and metabolic models                   | Mostly overlaps and cross-references Rhea and other biochemical sources; it needs provenance-aware deduplication                              |
| Reactome and BioModels                                 | Biological pathways, transport, binding, and quantitative models        | Many records are biological events rather than small-molecule transformations                                                                 |
| KEGG, MetaCyc, and BRENDA                              | Metabolic and enzymatic reactions                                       | Redistribution and commercial-use restrictions vary                                                                                           |
| CAS Reactions, Reaxys/SciFinder, SPRESI, and Pistachio | Broad literature and patent reaction coverage                           | Proprietary subscriptions and redistribution restrictions                                                                                     |
| ASKCOS and IBM RXN models                              | Product and synthesis prediction                                        | Predictions are not reported reactions; model/data terms and deployment requirements differ                                                   |

## Remaining limits

No database enumerates every possible reaction. Coverage outside reported records requires a
domain-specific predictor or equilibrium/mechanism solver. Any such result must be shown as
`Predicted`, include the model and conditions, and remain separate from reported evidence.
